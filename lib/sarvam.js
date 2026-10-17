// Thin client for the Sarvam AI REST APIs used by Charcha.
// Every call records a trace entry ({ model, task, ms }) so the UI can show
// exactly which Sarvam model did what.
import { unzip } from './unzip.js';
import { MAYURA_LANGS } from './catalog.js';

const BASE = 'https://api.sarvam.ai';
const KEY = process.env.SARVAM_API_KEY || process.env.API_KEY;

export const hasKey = () => Boolean(KEY);

export class SarvamError extends Error {
  constructor(where, status, message) {
    super(`${where} failed (${status}): ${message}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { json, form, method = 'POST', label = path } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'api-subscription-key': KEY,
        ...(json && { 'Content-Type': 'application/json' }),
      },
      body: json ? JSON.stringify(json) : form,
      signal: AbortSignal.timeout(90_000),
    });
    // Back off on rate limits and transient server errors.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(700 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const msg = data?.error?.message || data?.detail || (typeof data === 'string' ? data.slice(0, 300) : res.statusText);
      throw new SarvamError(label, res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }
}

/** Wraps a call so it appends { model, task, ms } to the given trace array. */
async function traced(trace, model, task, fn) {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    trace?.push({ model, task, ms: Date.now() - t });
  }
}

// ---------------------------------------------------------------- LLM

/** Chat completion. Returns the assistant message text. */
export async function chat({ model = 'sarvam-105b', messages, json = false, maxTokens = 4000, temperature = 0.7, trace, task = 'chat' }) {
  return traced(trace, model, task, async () => {
    const data = await request('/v1/chat/completions', {
      label: model,
      json: {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        // Reasoning is off: the scripts are creative writing, and reasoning
        // tokens add ~15s of latency with no visible quality gain.
        ...(model === 'sarvam-105b' && { reasoning_effort: null }),
        ...(json && { response_format: { type: 'json_object' } }),
      },
    });
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new SarvamError(model, 502, `empty response (finish_reason=${data.choices?.[0]?.finish_reason})`);
    return content;
  });
}

/** Parses JSON from an LLM reply, tolerating code fences or stray prose. */
export function parseJsonReply(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('Model did not return JSON');
}

// ---------------------------------------------------------------- Speech

export async function tts({ text, language, speaker, model = 'bulbul:v3', pace = 1.0, trace }) {
  return traced(trace, model, 'voice a line', async () => {
    const data = await request('/text-to-speech', {
      label: model,
      json: { text, language_code: language, speaker, model, pace, speech_sample_rate: 22050, output_audio_codec: 'wav' },
    });
    return data.audios?.[0];
  });
}

export async function stt({ buffer, mimetype, filename, model = 'saaras:v4', keyterms = [], trace }) {
  return traced(trace, model, 'transcribe speech', async () => {
    const form = new FormData();
    // Browsers label recordings like "audio/webm;codecs=opus"; send the bare type.
    form.append('file', new Blob([buffer], { type: (mimetype || 'audio/webm').split(';')[0] }), filename || 'audio.webm');
    form.append('model', model);
    form.append('language_code', 'unknown');
    const terms = keyterms.filter((t) => typeof t === 'string' && t.length && t.length <= 64).slice(0, 50);
    if (terms.length && model === 'saaras:v4') form.append('keyterms', JSON.stringify(terms));
    const data = await request('/speech-to-text', { form, label: model });
    return { transcript: data.transcript?.trim() || '', language: data.language_code || null };
  });
}

// ---------------------------------------------------------------- Text

export async function detectLanguage(text, trace) {
  return traced(trace, 'mayura:lid', 'detect language', async () => {
    const data = await request('/text-lid', { json: { input: text.slice(0, 1000) }, label: 'text-lid' });
    return { language: data.language_code, script: data.script_code };
  });
}

/**
 * Translates text. Mayura covers the 11 major languages and supports a
 * colloquial register; Sarvam-Translate covers all 22 scheduled languages.
 */
export async function translate({ text, source, target, trace, task = 'translate' }) {
  if (source === target) return { text, model: null };
  const useMayura = MAYURA_LANGS.has(target) && (source === 'auto' || MAYURA_LANGS.has(source));
  const model = useMayura ? 'mayura:v1' : 'sarvam-translate:v1';
  const max = useMayura ? 1000 : 2000;
  return traced(trace, model, task, async () => {
    const data = await request('/translate', {
      label: model,
      json: {
        input: text.slice(0, max),
        source_language_code: !useMayura && source === 'auto' ? 'en-IN' : source,
        target_language_code: target,
        model,
        ...(useMayura && { mode: 'modern-colloquial' }),
      },
    });
    return { text: data.translated_text, model };
  });
}

export async function transliterate({ text, source, target = 'en-IN', trace, task = 'romanise' }) {
  return traced(trace, 'transliterate', task, async () => {
    const data = await request('/transliterate', {
      label: 'transliterate',
      json: { input: text, source_language_code: source, target_language_code: target },
    });
    return data.transliterated_text;
  });
}

// ---------------------------------------------------------------- Vision

/** OCRs a PDF or image with Sarvam Vision (Document Intelligence) and returns markdown. */
export async function digitise({ buffer, filename, mimetype, language, trace }) {
  return traced(trace, 'sarvam-vision', 'read document', async () => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimetype }), filename);
    if (language) form.append('language', language);
    form.append('output_format', 'md');
    const job = await request('/doc-ai/v1/job/digitise', { form, label: 'sarvam-vision' });

    let status;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      status = await request(`/doc-ai/v1/job/${job.job_id}/status`, { method: 'GET', label: 'sarvam-vision status' });
      if (['completed', 'partially_completed', 'failed', 'rejected'].includes(status.status)) break;
    }
    if (!['completed', 'partially_completed'].includes(status?.status)) {
      throw new SarvamError('sarvam-vision', 422, `job ${status?.status || 'timed out'}`);
    }

    const dl = await request(`/doc-ai/v1/job/${job.job_id}/download-url`, { method: 'GET', label: 'sarvam-vision download' });
    const zipRes = await fetch(dl.url, { method: dl.method || 'GET' });
    const files = unzip(Buffer.from(await zipRes.arrayBuffer()));
    const markdown = Object.keys(files)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => files[name].toString('utf8'))
      .join('\n\n')
      .trim();
    return { markdown, pages: status.usage?.pages_succeeded ?? null };
  });
}
