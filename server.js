import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sarvam from './lib/sarvam.js';
import {
  PODCAST_LANGUAGES, ALL_LANGUAGES, VOICES, DEFAULT_HOSTS, STYLES, LENGTHS,
  languageByCode, voiceById,
} from './lib/catalog.js';
import { scriptMessages, answerMessages, cleanLines, MAX_SOURCE_CHARS } from './lib/prompts.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

const bad = (res, message) => res.status(400).json({ error: message });

/** Runs fn over items with at most `limit` in flight; preserves order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Language ID on a representative slice of the text. */
async function detect(text, trace) {
  const sample = text.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!sample) return { language: null, script: null };
  return sarvam.detectLanguage(sample, trace);
}

function validHosts(hosts) {
  return Array.isArray(hosts) && hosts.length === 2 && hosts.every((h) => voiceById(h)) && hosts[0] !== hosts[1];
}

/** Native-script spellings of the show and host names, so the LLM doesn't garble them. */
async function nativeNames(language, hosts, trace) {
  if (language === 'en-IN') return null;
  const words = ['Charcha', ...hosts.map((h) => voiceById(h).name)];
  try {
    const [show, ...names] = await Promise.all(
      words.map((text) => sarvam.transliterate({ text, source: 'en-IN', target: language, trace, task: 'spell names natively' })),
    );
    return { show, hosts: names };
  } catch {
    return null;
  }
}

function validNames(names) {
  return names && typeof names.show === 'string' && Array.isArray(names.hosts) && names.hosts.length === 2 ? names : null;
}

// ------------------------------------------------------------------ config

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: sarvam.hasKey(),
    podcastLanguages: PODCAST_LANGUAGES,
    allLanguages: ALL_LANGUAGES,
    voices: VOICES,
    defaultHosts: DEFAULT_HOSTS,
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, { label: s.label, blurb: s.blurb }])),
    lengths: LENGTHS,
    maxSourceChars: MAX_SOURCE_CHARS,
  });
});

// ------------------------------------------------------------------ sources

// PDF / image → Sarvam Vision OCR → language ID
app.post('/api/extract/file', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return bad(res, 'No file uploaded.');
  const ok = /^(application\/pdf|image\/(png|jpe?g))$/.test(file.mimetype);
  if (!ok) return bad(res, 'Upload a PDF (up to 10 pages) or a PNG/JPG image.');

  const trace = [];
  const language = languageByCode(req.body.language) ? req.body.language : undefined;
  const { markdown, pages } = await sarvam.digitise({
    buffer: file.buffer, filename: file.originalname, mimetype: file.mimetype, language, trace,
  });
  if (!markdown) return bad(res, 'Sarvam Vision could not find any text in that file.');
  const lid = await detect(markdown, trace);
  res.json({ text: markdown, pages, ...lid, trace });
});

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  const clean = (s) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const blocks = [...body.matchAll(/<(p|h[1-3]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => ({ tag: m[1].toLowerCase(), text: clean(m[2]) }))
    .filter((b) => b.text.length > 40 || (b.tag.startsWith('h') && b.text.length > 3));
  const text = blocks.length ? blocks.map((b) => b.text).join('\n\n') : clean(body);
  return { title, text };
}

function isPrivateHost(hostname) {
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(hostname);
}

// Web article → text → language ID
app.post('/api/extract/url', async (req, res) => {
  let url;
  try { url = new URL(String(req.body.url || '').trim()); } catch { return bad(res, 'That does not look like a valid link.'); }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return bad(res, 'Only public http(s) links are supported.');

  let html;
  try {
    const page = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Charcha podcast maker)', Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!page.ok) return bad(res, `The site responded with ${page.status}.`);
    html = await page.text();
  } catch {
    return bad(res, 'Could not fetch that page. Try pasting the text instead.');
  }
  const { title, text } = htmlToText(html);
  if (text.length < 200) return bad(res, 'Could not find readable article text on that page. Try pasting the text instead.');

  const trace = [];
  const lid = await detect(text, trace);
  res.json({ text: (title ? `${title}\n\n` : '') + text, title, ...lid, trace });
});

// Pasted text → language ID
app.post('/api/detect', async (req, res) => {
  const text = String(req.body.text || '');
  if (!text.trim()) return bad(res, 'No text to analyse.');
  const trace = [];
  res.json({ ...(await detect(text, trace)), trace });
});

// Voice note → Saaras
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!req.file) return bad(res, 'No audio received.');
  const trace = [];
  const out = await sarvam.stt({ buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname, trace });
  if (!out.transcript) return bad(res, 'Could not hear anything. Try again a little closer to the mic.');
  res.json({ ...out, trace });
});

// ------------------------------------------------------------------ episode

app.post('/api/script', async (req, res) => {
  const { source = '', topic = '', language, style, length, hosts } = req.body;
  if (!source.trim() && !topic.trim()) return bad(res, 'Give Charcha a document, a link, some text or a topic first.');
  if (!PODCAST_LANGUAGES.some((l) => l.code === language)) return bad(res, 'Unsupported podcast language.');
  if (!STYLES[style] || !LENGTHS[length]) return bad(res, 'Unknown style or length.');
  if (!validHosts(hosts)) return bad(res, 'Pick two different host voices.');

  const trace = [];
  const names = await nativeNames(language, hosts, trace);
  const messages = scriptMessages({ source: source.trim(), topic: topic.trim(), language, style, length, hostIds: hosts, names });
  let parsed;
  for (let attempt = 0; attempt < 2 && !parsed?.lines?.length; attempt++) {
    const reply = await sarvam.chat({ model: 'sarvam-105b', messages, json: true, maxTokens: 8000, trace, task: 'write the script' });
    try { parsed = sarvam.parseJsonReply(reply); } catch { parsed = null; }
  }
  const lines = cleanLines(parsed?.lines, hosts);
  if (!lines.length) return res.status(502).json({ error: 'The script writer returned an unusable script. Please try again.', trace });

  res.json({
    title: String(parsed.title || 'Charcha').trim(),
    summary: String(parsed.summary || '').trim(),
    keyterms: (Array.isArray(parsed.keyterms) ? parsed.keyterms : []).map(String).slice(0, 15),
    names,
    lines,
    trace,
  });
});

app.post('/api/tts', async (req, res) => {
  const { text, language, voice } = req.body;
  if (!text?.trim()) return bad(res, 'Nothing to say.');
  if (!PODCAST_LANGUAGES.some((l) => l.code === language) || !voiceById(voice)) return bad(res, 'Unknown language or voice.');
  const trace = [];
  const audio = await sarvam.tts({ text: text.slice(0, 2500), language, speaker: voice, trace });
  res.json({ audio, trace });
});

// Raise hand: (voice → Saaras | typed → LID) → translate to episode language → hosts answer
app.post('/api/ask', upload.single('audio'), async (req, res) => {
  let ctx;
  try { ctx = JSON.parse(req.body.context || '{}'); } catch { return bad(res, 'Bad request context.'); }
  const { language, style, hosts, title = '', source = '', topic = '', recentLines = [], keyterms = [], names } = ctx;
  if (!PODCAST_LANGUAGES.some((l) => l.code === language) || !STYLES[style] || !validHosts(hosts)) return bad(res, 'Missing episode context.');

  const trace = [];
  let question = String(req.body.question || '').trim();
  let questionLanguage;
  if (req.file) {
    const heard = await sarvam.stt({ buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname, keyterms, trace });
    question = heard.transcript;
    questionLanguage = heard.language;
  } else if (question) {
    questionLanguage = (await sarvam.detectLanguage(question, trace)).language;
  }
  if (!question) return bad(res, 'Could not hear a question. Try again a little closer to the mic.');

  // Hand the hosts the question in the episode's language so they reply in it.
  let translated = question;
  if (questionLanguage && questionLanguage !== language && languageByCode(questionLanguage)) {
    translated = (await sarvam.translate({ text: question, source: questionLanguage, target: language, trace, task: 'translate question' })).text;
  }

  const messages = answerMessages({
    question: translated, originalQuestion: question, questionLanguage, source, topic, title, language, style,
    hostIds: hosts, names: validNames(names), recentLines: recentLines.slice(-6),
  });
  let lines = [];
  for (let attempt = 0; attempt < 2 && !lines.length; attempt++) {
    const reply = await sarvam.chat({ model: 'sarvam-105b-conversations', messages, json: true, maxTokens: 1500, trace, task: 'answer live' });
    try { lines = cleanLines(sarvam.parseJsonReply(reply).lines, hosts); } catch { lines = []; }
  }
  if (!lines.length) return res.status(502).json({ error: 'The hosts got tongue-tied. Please ask again.', trace });

  res.json({ question, questionLanguage, translatedQuestion: translated !== question ? translated : null, lines, trace });
});

// Subtitles: romanise (Transliterate) or translate (Mayura / Sarvam-Translate)
app.post('/api/subtitles', async (req, res) => {
  const { lines, source, mode, target } = req.body;
  if (!Array.isArray(lines) || !lines.length) return bad(res, 'No lines to subtitle.');
  if (!PODCAST_LANGUAGES.some((l) => l.code === source)) return bad(res, 'Unknown source language.');
  if (mode === 'translate' && !languageByCode(target)) return bad(res, 'Unknown subtitle language.');
  if (mode !== 'translate' && mode !== 'roman') return bad(res, 'Unknown subtitle mode.');

  const trace = [];
  const out = await mapLimit(lines.slice(0, 80), 4, async (text) => {
    try {
      if (mode === 'roman') return source === 'en-IN' ? text : await sarvam.transliterate({ text, source, trace });
      return (await sarvam.translate({ text, source, target, trace, task: 'translate subtitles' })).text;
    } catch (err) {
      console.warn('subtitle line failed:', err.message);
      return null;
    }
  });
  res.json({ lines: out, trace });
});

// ------------------------------------------------------------------ errors

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 25 MB).' : err.message);
  const status = err instanceof sarvam.SarvamError && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`\n  Charcha is live at http://localhost:${PORT}\n`);
  if (!sarvam.hasKey()) console.warn('  ⚠ No Sarvam key found. Put SARVAM_API_KEY=... (or API_KEY=...) in .env\n');
});
