// Charcha front-end: compose an episode, play it line by line, and let the
// listener interrupt the hosts with spoken or typed questions.
import { SAMPLES, PREVIEW_LINES, ROLE_LABELS } from './content.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every Sarvam model Charcha uses. Ids match the `model` field in server traces.
const STACK = [
  { id: 'sarvam-vision', name: 'Sarvam Vision', kind: 'Vision', role: 'Reads PDFs and photos of pages in 23 languages.' },
  { id: 'mayura:lid', name: 'Language ID', code: 'text-lid', kind: 'Text', role: 'Spots the language and script of any text, even romanised Hinglish.' },
  { id: 'sarvam-105b', name: 'Sarvam-105B', kind: 'LLM', role: 'Writes the whole episode script in your language.' },
  { id: 'transliterate', name: 'Transliterate', kind: 'Text', role: 'Spells host names natively; romanised subtitles for people who speak but can’t read a script.' },
  { id: 'bulbul:v3', name: 'Bulbul v3', kind: 'TTS', role: 'Gives each host a distinct, natural voice.' },
  { id: 'saaras:v4', name: 'Saaras v4', kind: 'STT', role: 'Hears your questions and topics in any Indian language, biased to the episode’s key terms.' },
  { id: 'mayura:v1', name: 'Mayura', kind: 'Translate', role: 'Translates your question for the hosts, and subtitles in a colloquial register.' },
  { id: 'sarvam-105b-conversations', name: 'Sarvam-105B Conversations', kind: 'LLM', role: 'Lets the hosts answer you live, mid-episode.' },
  { id: 'sarvam-translate:v1', name: 'Sarvam-Translate', kind: 'Translate', role: 'Subtitles in all 22 scheduled languages, Urdu to Santali.' },
];

const state = {
  config: null,
  tab: 'upload',
  loaded: { upload: null, link: null }, // { text, label, language, script, pages }
  pasteLang: null,
  language: 'hi-IN',
  style: 'chai',
  length: 'short',
  hosts: ['shubh', 'ishita'],
  episode: null,
  speed: 1,
  subMode: 'off',
  subTarget: 'en-IN',
  usage: Object.fromEntries(STACK.map((m) => [m.id, { count: 0, ms: 0 }])),
};

// ────────────────────────────────────────────────────────────── utilities

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 6000 : 3200);
}

async function api(path, body, { form } = {}) {
  let res;
  try {
    res = await fetch(path, form
      ? { method: 'POST', body: form }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Could not reach the Charcha server. Is it running?');
  }
  let data;
  try { data = await res.json(); } catch { data = { error: `Server error (${res.status})` }; }
  if (data.trace) recordTrace(data.trace);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  p.catch(() => {});
  return Object.assign(p, { resolve, reject });
}

const langName = (code) => state.config.allLanguages.find((l) => l.code === code)?.name || code;
const voice = (id) => state.config.voices.find((v) => v.id === id);
const scriptName = { Latn: 'Latin', Deva: 'Devanagari', Beng: 'Bengali', Gujr: 'Gujarati', Knda: 'Kannada', Mlym: 'Malayalam', Orya: 'Odia', Guru: 'Gurmukhi', Taml: 'Tamil', Telu: 'Telugu' };
function describeLanguage(language, script) {
  if (!language) return 'language unknown';
  const name = langName(language);
  if (script === 'Latn' && language !== 'en-IN') return `${name} · romanised`;
  return name;
}

// ────────────────────────────────────────────────────────────── model stack

function renderStack() {
  $('#stackGrid').innerHTML = STACK.map((m) => `
    <article class="model-card" data-model="${m.id}">
      <div class="mc-top"><span class="kind">${m.kind}</span><span class="count">unused</span></div>
      <h4>${esc(m.name)}</h4>
      <code>${esc(m.code || m.id)}</code>
      <p>${esc(m.role)}</p>
      <span class="lat"></span>
    </article>`).join('');
}

function recordTrace(trace) {
  const log = $('#activityLog');
  $('.muted', log)?.remove();
  for (const t of trace) {
    const u = state.usage[t.model];
    if (u) {
      u.count++;
      u.ms += t.ms;
      const card = $(`.model-card[data-model="${CSS.escape(t.model)}"]`);
      card.classList.add('used', 'flash');
      setTimeout(() => card.classList.remove('flash'), 900);
      $('.count', card).textContent = `×${u.count}`;
      $('.lat', card).textContent = `avg ${(u.ms / u.count / 1000).toFixed(2)}s`;
    }
    const li = document.createElement('li');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<span class="t">${time}</span><span class="m">${esc(t.model)}</span><span class="task">${esc(t.task)}</span><span class="ms">${(t.ms / 1000).toFixed(2)}s</span>`;
    log.prepend(li);
  }
  while (log.children.length > 60) log.lastElementChild.remove();
  const used = Object.values(state.usage).filter((u) => u.count).length;
  $('#stackCount').textContent = used;
  $('.stack-pill').classList.toggle('live', used > 0);
}

// ────────────────────────────────────────────────────────────── compose UI

function renderCompose() {
  const { config } = state;
  $('#docLang').innerHTML = `<option value="">Auto (Indian language)</option>` +
    config.allLanguages.map((l) => `<option value="${l.code}">${esc(l.name)} · ${esc(l.native)}</option>`).join('');

  $('#langChips').innerHTML = config.podcastLanguages.map((l) => `
    <button class="chip" role="radio" data-lang="${l.code}" aria-checked="${l.code === state.language}">
      ${esc(l.native)}${l.code !== 'en-IN' ? `<small>${esc(l.name)}</small>` : ''}
    </button>`).join('');

  $('#styleCards').innerHTML = Object.entries(config.styles).map(([k, s]) => `
    <button class="style-card" role="radio" data-style="${k}" aria-checked="${k === state.style}">
      <b>${esc(s.label)}</b><span>${esc(s.blurb)}</span>
    </button>`).join('');

  $('#lengthSeg').innerHTML = Object.entries(config.lengths).map(([k, l]) => `
    <button role="radio" data-length="${k}" aria-checked="${k === state.length}">${esc(l.label)}<small>${esc(l.approx)}</small></button>`).join('');

  const options = (selected) => ['female', 'male'].map((g) => `
    <optgroup label="${g === 'female' ? 'Female voices' : 'Male voices'}">
      ${config.voices.filter((v) => v.gender === g).map((v) => `<option value="${v.id}" ${v.id === selected ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
    </optgroup>`).join('');
  $('#hostA').innerHTML = options(state.hosts[0]);
  $('#hostB').innerHTML = options(state.hosts[1]);
  renderRoles();

  $('#subsLang').innerHTML = config.allLanguages.map((l) => `<option value="${l.code}" ${l.code === state.subTarget ? 'selected' : ''}>${esc(l.name)} · ${esc(l.native)}</option>`).join('');
}

function renderRoles() {
  const [a, b] = ROLE_LABELS[state.style];
  $('#roleA').textContent = a;
  $('#roleB').textContent = b;
}

function selectRadio(container, attr, value) {
  $$(`[${attr}]`, container).forEach((b) => b.setAttribute('aria-checked', String(b.getAttribute(attr) === value)));
}

function setTab(tab) {
  state.tab = tab;
  $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tabpanel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  renderSourceCard();
}

function renderSourceCard() {
  const src = state.loaded[state.tab];
  const card = $('#sourceCard');
  card.hidden = !src;
  if (!src) return;
  $('#sourceLabel').textContent = src.label;
  const bits = [];
  if (src.pages) bits.push(`${src.pages} page${src.pages > 1 ? 's' : ''}`);
  bits.push(`<b>${esc(describeLanguage(src.language, src.script))}</b>`);
  bits.push(`${src.text.length.toLocaleString()} characters`);
  if (src.text.length > state.config.maxSourceChars) bits.push(`first ${state.config.maxSourceChars.toLocaleString()} used`);
  bits.push(`via ${src.via}`);
  $('#sourceMeta').innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
  $('#sourcePreview').textContent = src.text.slice(0, 4000) + (src.text.length > 4000 ? '\n…' : '');
}

async function handleFile(file) {
  if (!file) return;
  if (!/^(application\/pdf|image\/(png|jpe?g))$/.test(file.type)) return toast('Please choose a PDF, PNG or JPG.', 'error');
  const dz = $('#dropzone');
  dz.classList.add('busy');
  const title = $('.dz-title', dz);
  const started = Date.now();
  const tick = setInterval(() => (title.textContent = `Sarvam Vision is reading… ${Math.round((Date.now() - started) / 1000)}s`), 500);
  try {
    const form = new FormData();
    form.append('file', file);
    if ($('#docLang').value) form.append('language', $('#docLang').value);
    const data = await api('/api/extract/file', null, { form });
    state.loaded.upload = { ...data, label: file.name, via: 'Sarvam Vision' };
    renderSourceCard();
    toast(`Read ${data.text.length.toLocaleString()} characters of ${describeLanguage(data.language, data.script)}.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    clearInterval(tick);
    title.textContent = 'Drop a PDF or a photo';
    dz.classList.remove('busy');
    $('#fileInput').value = '';
  }
}

let pasteTimer;
function onPasteInput() {
  clearTimeout(pasteTimer);
  const text = $('#pasteInput').value.trim();
  if (text.length < 12) { $('#pasteLang').hidden = true; state.pasteLang = null; return; }
  pasteTimer = setTimeout(async () => {
    try {
      const { language, script } = await api('/api/detect', { text });
      state.pasteLang = language;
      const chip = $('#pasteLang');
      chip.textContent = `Detected: ${describeLanguage(language, script)}`;
      chip.hidden = false;
    } catch { /* detection is a nicety */ }
  }, 700);
}

// ────────────────────────────────────────────────────────────── recording

const recorder = {
  rec: null, stream: null, chunks: [], ctx: null, raf: 0, timeout: 0,
  async start(onLevel) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
    if (onLevel) {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const loop = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        onLevel(Math.min(1, peak / 64));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    }
  },
  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      this.rec.onstop = () => {
        const type = this.rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(this.raf);
        this.ctx?.close();
        Object.assign(this, { rec: null, stream: null, ctx: null });
        resolve(blob);
      };
      this.rec.stop();
    });
  },
  get active() { return Boolean(this.rec); },
};

const extFor = (type) => (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm');

async function topicMic() {
  const btn = $('#topicMic');
  if (recorder.active) {
    clearTimeout(recorder.timeout);
    btn.classList.remove('recording');
    $('span', btn).textContent = 'Hearing…';
    btn.disabled = true;
    try {
      const blob = await recorder.stop();
      const form = new FormData();
      form.append('audio', blob, `topic.${extFor(blob.type)}`);
      const { transcript, language } = await api('/api/stt', null, { form });
      $('#topicInput').value = transcript;
      toast(`Heard you in ${langName(language)}.`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      $('span', btn).textContent = 'Say it';
    }
    return;
  }
  try {
    await recorder.start();
  } catch {
    return toast('Microphone access was blocked.', 'error');
  }
  btn.classList.add('recording');
  $('span', btn).textContent = 'Stop';
  recorder.timeout = setTimeout(() => recorder.active && topicMic(), 15_000);
}

// ────────────────────────────────────────────────────────────── voice preview

const previewCache = new Map();
const previewAudio = new Audio();
async function previewVoice(slot, btn) {
  const id = state.hosts[slot];
  const key = `${id}|${state.language}`;
  btn.classList.add('loading');
  try {
    if (!previewCache.has(key)) {
      const { audio } = await api('/api/tts', { text: PREVIEW_LINES[state.language], language: state.language, voice: id });
      previewCache.set(key, URL.createObjectURL(b64ToBlob(audio)));
    }
    previewAudio.src = previewCache.get(key);
    previewAudio.play();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

// ────────────────────────────────────────────────────────────── generation

function currentSource() {
  switch (state.tab) {
    case 'upload':
    case 'link':
      return state.loaded[state.tab] && { source: state.loaded[state.tab].text };
    case 'paste': {
      const text = $('#pasteInput').value.trim();
      return text && { source: text };
    }
    case 'topic': {
      const topic = $('#topicInput').value.trim();
      return topic && { topic };
    }
  }
}

function showOnAir(which) {
  $('#stateEmpty').hidden = which !== 'empty';
  $('#stateWorking').hidden = which !== 'working';
  $('#player').hidden = which !== 'player';
}

function renderStages(stages) {
  $('#stages').innerHTML = stages.map((s) => `
    <li class="${s.status}"><span class="st-icon"></span><span class="st-text">${esc(s.title)}<small>${esc(s.sub)}</small></span></li>`).join('');
}

async function generate() {
  const src = currentSource();
  if (!src) {
    const hints = { upload: 'Upload a PDF or photo first.', link: 'Fetch a link first.', paste: 'Paste some text first.', topic: 'Type or say a topic first.' };
    return toast(hints[state.tab], 'error');
  }
  if (state.tab === 'link' && !state.loaded.link) return;
  if (state.episode) teardownEpisode();

  const btn = $('#generateBtn');
  btn.disabled = true;
  showOnAir('working');
  if (window.matchMedia('(max-width: 980px)').matches) $('#onair').scrollIntoView({ behavior: 'smooth' });

  const lang = langName(state.language);
  const styleLabel = state.config.styles[state.style].label;
  const [a, b] = state.hosts.map((h) => voice(h).name);
  const stages = [
    { status: 'done', title: src.topic ? 'Topic received' : 'Source ready', sub: src.topic ? `“${src.topic.slice(0, 60)}”` : `${src.source.length.toLocaleString()} characters` },
    { status: 'active', title: `Writing a ${styleLabel} script in ${lang}`, sub: 'Sarvam-105B' },
    { status: '', title: `Warming up ${a} & ${b}`, sub: 'Bulbul v3' },
  ];
  renderStages(stages);

  try {
    const script = await api('/api/script', { ...src, language: state.language, style: state.style, length: state.length, hosts: state.hosts });
    stages[1].status = 'done';
    stages[2].status = 'active';
    renderStages(stages);
    startEpisode(script, src);
  } catch (err) {
    toast(err.message, 'error');
    showOnAir(state.episode ? 'player' : 'empty');
  } finally {
    btn.disabled = false;
  }
}

// ────────────────────────────────────────────────────────────── episode model

let uid = 0;
const audio = new Audio();
audio.preservesPitch = true;

function makeLine(host, text, extra = {}) {
  return { id: ++uid, kind: 'line', host, text, status: 'idle', url: null, blob: null, ready: deferred(), subs: {}, ...extra };
}

function startEpisode(script, src) {
  const ep = {
    title: script.title,
    summary: script.summary,
    keyterms: script.keyterms || [],
    names: script.names,
    language: state.language,
    style: state.style,
    hosts: [...state.hosts],
    source: src.source || '',
    topic: src.topic || '',
    items: script.lines.map((l) => makeLine(l.host, l.text)),
    cur: -1,
    playing: false,
    token: 0,
    inflight: 0,
  };
  state.episode = ep;

  const styleLabel = state.config.styles[ep.style].label;
  $('#epKicker').innerHTML = [langName(ep.language), styleLabel, `${ep.items.length} lines`].map((s) => `<span>${esc(s)}</span>`).join('');
  $('#epTitle').textContent = ep.title;
  $('#epSummary').textContent = ep.summary;
  for (const [i, el] of [[0, $('#avatarA')], [1, $('#avatarB')]]) {
    const v = voice(ep.hosts[i]);
    $('.initial', el).textContent = v.name[0];
    $('.name', el).textContent = v.name;
  }
  $('#subsSeg [data-sub="roman"]').disabled = ep.language === 'en-IN';
  if (ep.language === 'en-IN' && state.subMode === 'roman') setSubMode('off');

  renderTranscript();
  pump();

  // The first line is usually ready within ~3s; start playing as soon as it is.
  ep.items[0].ready.then(() => {
    if (state.episode !== ep) return;
    showOnAir('player');
    if (ep.cur < 0) playAt(0);
  }).catch(() => {
    if (state.episode !== ep) return;
    showOnAir('player');
    toast('Could not voice the first line. Tap a line to retry.', 'error');
  });
  if (state.subMode !== 'off') fetchSubs();
}

function teardownEpisode() {
  const ep = state.episode;
  ep.token++;
  ep.dead = true;
  audio.pause();
  audio.removeAttribute('src');
  for (const it of ep.items) if (it.url) URL.revokeObjectURL(it.url);
  state.episode = null;
}

const spoken = (ep) => ep.items.filter((it) => it.kind === 'line');

// ────────────────────────────────────────────────────────────── TTS scheduler

const MAX_TTS_INFLIGHT = 3;

function b64ToBlob(b64, type = 'audio/wav') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Voices lines in order of distance from the playhead, a few at a time. */
function pump() {
  const ep = state.episode;
  if (!ep) return;
  while (ep.inflight < MAX_TTS_INFLIGHT) {
    const from = Math.max(ep.cur, 0);
    const next = ep.items.slice(from).find((it) => it.kind === 'line' && it.status === 'idle')
      || ep.items.find((it) => it.kind === 'line' && it.status === 'idle');
    if (!next) return;
    voiceLine(ep, next);
  }
}

async function voiceLine(ep, line) {
  line.status = 'loading';
  ep.inflight++;
  updateLineEl(line);
  try {
    const { audio: b64 } = await api('/api/tts', { text: line.text, language: ep.language, voice: ep.hosts[line.host] });
    if (ep.dead) return;
    line.blob = b64ToBlob(b64);
    line.url = URL.createObjectURL(line.blob);
    line.status = 'ready';
    line.ready.resolve();
  } catch (err) {
    line.status = 'error';
    line.ready.reject(err);
  } finally {
    ep.inflight--;
    if (!ep.dead) {
      updateLineEl(line);
      pump();
    }
  }
}

function retryLine(line) {
  line.status = 'idle';
  line.ready = deferred();
  updateLineEl(line);
  pump();
}

// ────────────────────────────────────────────────────────────── playback

async function playAt(index) {
  const ep = state.episode;
  if (!ep) return;
  const token = ++ep.token;
  while (index < ep.items.length && ep.items[index].kind !== 'line') index++;
  if (index >= ep.items.length) return finish();

  ep.cur = index;
  ep.playing = true;
  const line = ep.items[index];
  if (line.status === 'error') retryLine(line);
  markCurrent();
  pump();

  if (line.status !== 'ready') {
    setBuffering(true);
    try { await line.ready; } catch {
      if (token !== ep.token) return;
      setBuffering(false);
      toast('Skipped a line that could not be voiced.', 'error');
      return playAt(index + 1);
    }
    if (token !== ep.token) return;
    setBuffering(false);
  }
  audio.src = line.url;
  audio.dataset.lineId = line.id;
  audio.playbackRate = state.speed;
  try {
    await audio.play();
  } catch {
    if (token === ep.token) { ep.playing = false; updatePlayButton(); }
  }
}

function finish() {
  const ep = state.episode;
  ep.playing = false;
  ep.cur = ep.items.length;
  markCurrent();
  updatePlayButton();
}

function play() {
  const ep = state.episode;
  if (!ep) return;
  const line = ep.items[ep.cur];
  if (line && audio.dataset.lineId === String(line.id) && audio.src && !audio.ended) {
    ep.playing = true;
    audio.play();
    updatePlayButton();
  } else {
    playAt(ep.cur < 0 || ep.cur >= ep.items.length ? 0 : ep.cur);
  }
}

function pause() {
  const ep = state.episode;
  if (!ep) return;
  ep.playing = false;
  ep.token++;
  audio.pause();
  setBuffering(false);
  updatePlayButton();
}

function step(dir) {
  const ep = state.episode;
  if (!ep) return;
  const idx = ep.items.map((it, i) => (it.kind === 'line' ? i : -1)).filter((i) => i >= 0);
  const pos = idx.indexOf(ep.cur);
  const target = dir > 0 ? idx[pos + 1] : idx[Math.max(0, pos - 1)];
  if (target === undefined) return finish();
  playAt(target);
}

audio.addEventListener('ended', () => {
  const ep = state.episode;
  if (ep?.playing) playAt(ep.cur + 1);
});
audio.addEventListener('play', updatePlayButton);
audio.addEventListener('pause', updatePlayButton);

function setBuffering(on) {
  $('#playBtn').classList.toggle('buffering', on);
}

function updatePlayButton() {
  const ep = state.episode;
  const playing = Boolean(ep?.playing);
  const btn = $('#playBtn');
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const line = ep?.items[ep.cur];
  const talking = playing && line?.kind === 'line' && !audio.paused;
  $('#avatarA').classList.toggle('speaking', talking && line.host === 0);
  $('#avatarB').classList.toggle('speaking', talking && line.host === 1);
  $('#avatarA').classList.toggle('idle', talking && line.host !== 0);
  $('#avatarB').classList.toggle('idle', talking && line.host !== 1);
}

// Progress fill, driven by the audio clock.
function tickProgress() {
  const ep = state.episode;
  if (ep && !$('#player').hidden) {
    const lines = spoken(ep);
    const curLine = ep.items[ep.cur];
    const curPos = curLine ? lines.indexOf(curLine) : ep.cur >= ep.items.length ? lines.length : -1;
    $$('#segments .seg').forEach((seg, i) => {
      let pct = 0;
      if (i < curPos) pct = 100;
      else if (i === curPos && audio.duration && audio.dataset.lineId === String(curLine.id)) pct = (audio.currentTime / audio.duration) * 100;
      seg.firstElementChild.style.width = `${pct}%`;
    });
    $('#lineCounter').textContent = `${Math.max(0, Math.min(curPos + 1, lines.length))} / ${lines.length} lines`;
  }
  requestAnimationFrame(tickProgress);
}

// ────────────────────────────────────────────────────────────── transcript

function renderTranscript() {
  const ep = state.episode;
  const list = $('#transcript');
  list.innerHTML = '';
  for (const it of ep.items) {
    const li = document.createElement('li');
    it.el = li;
    if (it.kind === 'question') {
      li.className = 't-question';
      li.innerHTML = `<svg><use href="#i-hand"/></svg><div>
        <div class="q-who">You asked${it.language ? ` · ${esc(langName(it.language))}` : ''}</div>
        <div class="q-text">${esc(it.text)}</div>
        ${it.translated ? `<div class="q-tr">→ ${esc(it.translated)}</div>` : ''}
      </div>`;
    } else {
      const v = voice(ep.hosts[it.host]);
      li.className = `t-line ${it.host ? 'b' : 'a'}${it.qa ? ' qa' : ''}`;
      li.innerHTML = `<span class="av">${esc(v.name[0])}</span><div>
        <div class="who">${esc(v.name)}${it.qa ? '<span class="badge">live answer</span>' : ''}</div>
        <div class="txt" lang="${ep.language.slice(0, 2)}">${esc(it.text)}</div>
        <div class="sub" hidden></div>
      </div>`;
      li.addEventListener('click', () => playAt(ep.items.indexOf(it)));
      updateLineEl(it);
    }
    list.append(li);
  }
  renderSegments();
  markCurrent(false);
}

function updateLineEl(line) {
  const li = line.el;
  if (!li || line.kind !== 'line') return;
  li.classList.toggle('pending', line.status !== 'ready');
  li.classList.toggle('error', line.status === 'error');
  const seg = $(`#segments .seg[data-id="${line.id}"]`);
  seg?.classList.toggle('loading', line.status === 'loading');
  const sub = $('.sub', li);
  const key = subKey();
  if (!key) { sub.hidden = true; return; }
  sub.hidden = false;
  const val = line.subs[key];
  sub.classList.toggle('pending', val === undefined);
  sub.textContent = val === undefined ? '…' : val ?? '(subtitle unavailable)';
}

function renderSegments() {
  const ep = state.episode;
  $('#segments').innerHTML = spoken(ep).map((l) => `
    <div class="seg ${l.host ? 'b' : 'a'}${l.qa ? ' qa' : ''}${l.status === 'loading' ? ' loading' : ''}" data-id="${l.id}" style="flex-grow:${Math.max(20, l.text.length)}" title="${esc(voice(ep.hosts[l.host]).name)}"><span class="fill"></span></div>`).join('');
}

function markCurrent(scroll = true) {
  const ep = state.episode;
  if (!ep) return;
  ep.items.forEach((it, i) => it.el?.classList.toggle('current', i === ep.cur));
  const el = ep.items[ep.cur]?.el;
  if (scroll && el) {
    const list = $('#transcript');
    list.scrollTo({ top: el.offsetTop - list.offsetTop - 60, behavior: 'smooth' });
  }
  updatePlayButton();
}

// ────────────────────────────────────────────────────────────── subtitles

function subKey() {
  if (state.subMode === 'off') return null;
  return state.subMode === 'roman' ? 'roman' : `tr:${state.subTarget}`;
}

function setSubMode(mode) {
  state.subMode = mode;
  selectRadio($('#subsSeg'), 'data-sub', mode);
  $('#subsLang').hidden = mode !== 'translate';
  if (state.episode) {
    spoken(state.episode).forEach(updateLineEl);
    if (mode !== 'off') fetchSubs();
  }
}

async function fetchSubs() {
  const ep = state.episode;
  const key = subKey();
  if (!ep || !key) return;
  const todo = spoken(ep).filter((l) => !(key in l.subs) && !l.subsLoading?.has(key));
  if (!todo.length) return;
  todo.forEach((l) => (l.subsLoading ??= new Set()).add(key));
  const body = { source: ep.language, mode: state.subMode === 'roman' ? 'roman' : 'translate', target: state.subTarget };
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    try {
      const { lines } = await api('/api/subtitles', { ...body, lines: batch.map((l) => l.text) });
      batch.forEach((l, j) => (l.subs[key] = lines[j]));
    } catch (err) {
      toast(err.message, 'error');
      batch.forEach((l) => (l.subs[key] = null));
    }
    batch.forEach((l) => { l.subsLoading.delete(key); updateLineEl(l); });
    if (state.episode !== ep) return;
  }
}

// ────────────────────────────────────────────────────────────── raise hand

function setHandStatus(html) {
  const el = $('#handStatus');
  el.hidden = !html;
  el.innerHTML = html || '';
}

async function raiseHand() {
  const ep = state.episode;
  if (!ep) return;
  const btn = $('#handBtn');
  if (recorder.active) return sendSpokenQuestion();
  pause();
  try {
    await recorder.start((level) => btn.style.setProperty('--level', level.toFixed(2)));
  } catch {
    return toast('Microphone access was blocked. You can type your question instead.', 'error');
  }
  btn.classList.add('recording');
  $('#handLabel').textContent = 'Send question';
  const started = Date.now();
  const tick = () => {
    if (!recorder.active) return;
    setHandStatus(`Listening… ask in any language · ${Math.round((Date.now() - started) / 1000)}s`);
    setTimeout(tick, 250);
  };
  tick();
  recorder.timeout = setTimeout(() => recorder.active && sendSpokenQuestion(), 25_000);
}

async function sendSpokenQuestion() {
  clearTimeout(recorder.timeout);
  const btn = $('#handBtn');
  btn.classList.remove('recording');
  btn.style.removeProperty('--level');
  $('#handLabel').textContent = 'Raise hand';
  const blob = await recorder.stop();
  if (!blob || blob.size < 1500) { setHandStatus(''); return toast('That was too short. Try again.', 'error'); }
  const form = new FormData();
  form.append('audio', blob, `question.${extFor(blob.type)}`);
  await ask(form, 'Saaras is listening back');
}

async function askTyped(e) {
  e.preventDefault();
  const input = $('#askInput');
  const question = input.value.trim();
  if (!question || !state.episode) return;
  pause();
  const form = new FormData();
  form.append('question', question);
  input.value = '';
  await ask(form, 'Reading your question');
}

async function ask(form, firstStep) {
  const ep = state.episode;
  const names = ep.hosts.map((h) => voice(h).name);
  const heard = ep.items.slice(0, Math.min(ep.cur + 1, ep.items.length) || 1).filter((it) => it.kind === 'line');
  form.append('context', JSON.stringify({
    language: ep.language, style: ep.style, hosts: ep.hosts, title: ep.title,
    source: ep.source.slice(0, 12_000), topic: ep.topic, keyterms: ep.keyterms, names: ep.names,
    recentLines: heard.slice(-6).map((l) => ({ speaker: names[l.host], text: l.text })),
  }));

  $('#handBtn').disabled = true;
  setHandStatus(`<span class="dots">${esc(firstStep)} · translating · ${esc(names.join(' & '))} are thinking</span>`);
  try {
    const data = await api('/api/ask', null, { form });
    if (state.episode !== ep) return;
    const at = Math.min(ep.cur + 1, ep.items.length);
    const q = { id: ++uid, kind: 'question', text: data.question, translated: data.translatedQuestion, language: data.questionLanguage };
    const answers = data.lines.map((l) => makeLine(l.host, l.text, { qa: true }));
    ep.items.splice(at, 0, q, ...answers);
    renderTranscript();
    if (state.subMode !== 'off') fetchSubs();
    playAt(at + 1);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#handBtn').disabled = false;
    setHandStatus('');
  }
}

// ────────────────────────────────────────────────────────────── download

function readWav(buf) {
  const dv = new DataView(buf);
  let p = 12, fmt, data;
  while (p + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    if (id === 'data') { data = new Uint8Array(buf, p + 8, Math.min(size, dv.byteLength - p - 8)); break; }
    p += 8 + size + (size & 1);
  }
  return { fmt, data };
}

function buildWav(parts, fmt, gapSec = 0.35) {
  const bytesPerSec = fmt.rate * fmt.channels * (fmt.bits / 8);
  const gap = new Uint8Array(Math.round(gapSec * bytesPerSec / 2) * 2);
  const total = parts.reduce((n, p) => n + p.length + gap.length, 0);
  const out = new Uint8Array(44 + total);
  const dv = new DataView(out.buffer);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + total, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, fmt.channels, true);
  dv.setUint32(24, fmt.rate, true); dv.setUint32(28, bytesPerSec, true); dv.setUint16(32, fmt.channels * fmt.bits / 8, true); dv.setUint16(34, fmt.bits, true);
  w(36, 'data'); dv.setUint32(40, total, true);
  let o = 44;
  for (const p of parts) { out.set(p, o); o += p.length + gap.length; }
  return new Blob([out], { type: 'audio/wav' });
}

async function download() {
  const ep = state.episode;
  if (!ep) return;
  const btn = $('#downloadBtn');
  btn.disabled = true;
  $('span', btn).textContent = 'Voicing all lines…';
  try {
    const lines = spoken(ep);
    lines.filter((l) => l.status === 'error').forEach(retryLine);
    pump();
    await Promise.allSettled(lines.map((l) => l.ready));
    const wavs = await Promise.all(lines.filter((l) => l.blob).map(async (l) => readWav(await l.blob.arrayBuffer())));
    const fmt = wavs.find((w) => w.fmt)?.fmt;
    if (!fmt) throw new Error('No audio to download yet.');
    const blob = buildWav(wavs.filter((w) => w.data).map((w) => w.data), fmt);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `charcha-${ep.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) || 'episode'}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    $('span', btn).textContent = 'Download';
  }
}

// ────────────────────────────────────────────────────────────── theme

function initTheme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem('charcha-theme'); } catch {}
  if (saved) root.dataset.theme = saved;
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const sync = () => ($('#themeToggle use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon'));
  sync();
  $('#themeToggle').addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('charcha-theme', root.dataset.theme); } catch {}
    sync();
  });
}

// ────────────────────────────────────────────────────────────── wiring

function bind() {
  $$('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  const dz = $('#dropzone');
  $('#fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });

  $('#pasteInput').addEventListener('input', onPasteInput);
  $$('[data-sample]').forEach((b) => b.addEventListener('click', () => {
    $('#pasteInput').value = SAMPLES[b.dataset.sample];
    onPasteInput();
  }));

  $('#linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#linkBtn');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const url = $('#linkInput').value.trim();
      const data = await api('/api/extract/url', { url });
      state.loaded.link = { ...data, label: data.title || new URL(url).hostname, via: 'web page' };
      renderSourceCard();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch';
    }
  });

  $('#topicMic').addEventListener('click', topicMic);
  $('#sourceClear').addEventListener('click', () => { state.loaded[state.tab] = null; renderSourceCard(); });

  $('#langChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    state.language = b.dataset.lang;
    selectRadio($('#langChips'), 'data-lang', state.language);
  });
  $('#styleCards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    state.style = b.dataset.style;
    selectRadio($('#styleCards'), 'data-style', state.style);
    renderRoles();
  });
  $('#lengthSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-length]');
    if (!b) return;
    state.length = b.dataset.length;
    selectRadio($('#lengthSeg'), 'data-length', state.length);
  });
  for (const [i, sel] of [[0, '#hostA'], [1, '#hostB']]) {
    $(sel).addEventListener('change', (e) => {
      if (e.target.value === state.hosts[1 - i]) {
        toast('Pick two different voices so you can tell the hosts apart.', 'error');
        e.target.value = state.hosts[i];
        return;
      }
      state.hosts[i] = e.target.value;
    });
  }
  $$('[data-preview]').forEach((b) => b.addEventListener('click', () => previewVoice(Number(b.dataset.preview), b)));

  $('#generateBtn').addEventListener('click', generate);

  $('#playBtn').addEventListener('click', () => (state.episode?.playing ? pause() : play()));
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));
  $('#speedBtn').addEventListener('click', () => {
    const speeds = [1, 1.25, 1.5, 0.85];
    state.speed = speeds[(speeds.indexOf(state.speed) + 1) % speeds.length];
    audio.playbackRate = state.speed;
    $('#speedBtn').textContent = `${state.speed}×`;
  });
  $('#downloadBtn').addEventListener('click', download);
  $('#segments').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    const ep = state.episode;
    if (!seg || !ep) return;
    playAt(ep.items.findIndex((it) => String(it.id) === seg.dataset.id));
  });

  $('#subsSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sub]');
    if (b && !b.disabled) setSubMode(b.dataset.sub);
  });
  $('#subsLang').addEventListener('change', (e) => { state.subTarget = e.target.value; setSubMode('translate'); });

  $('#handBtn').addEventListener('click', raiseHand);
  $('#askForm').addEventListener('submit', askTyped);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey || !state.episode) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); state.episode.playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key.toLowerCase() === 'h') raiseHand();
  });

}

async function init() {
  initTheme();
  renderStack();
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {
    toast('Could not load configuration from the server.', 'error');
    return;
  }
  $('#keyBanner').hidden = state.config.hasKey;
  state.hosts = [...state.config.defaultHosts];
  renderCompose();
  bind();
  setTab('upload');
  requestAnimationFrame(tickProgress);
}

init();
