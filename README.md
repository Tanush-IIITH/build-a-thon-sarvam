# Charcha (चर्चा)

**Any document → a podcast in your language, and you can interrupt the hosts.**

Charcha turns a PDF, a photo of a page, a web link, pasted text or just a spoken topic into a lively two-host podcast in any of 11 Indian languages. While the episode plays, you can **raise your hand**, ask a question out loud *in any language*, and the hosts stop, answer you on air in the episode's language, and then carry on with the show.

Think NotebookLM's Audio Overview, built for Bharat: multilingual on the way in, multilingual on the way out, and interactive in the middle.

---

## Why we built it

- Most of what Indian students and citizens need to read (textbooks, government circulars, news, research) is in a language or a format that isn't the one they're most comfortable with.
- Many people **speak** a language fluently but can't comfortably **read** its script. Others learn better by listening than by reading dense text.
- Static summaries can't answer the follow-up question you actually have.

Charcha makes any material *listenable* in your mother tongue and lets you ask about it in whatever language you think in.

---

## Features

### 1. Bring any source
| Input | How it's handled |
|---|---|
| **Upload** a PDF (≤10 pages) or PNG/JPG photo | OCR'd by **Sarvam Vision**. Handles textbook pages, newspaper clippings and handwritten-style notes in 23 languages |
| **Paste** text | Language and script detected live (e.g. "Hindi · romanised" for Hinglish) |
| **Link** to an article | Fetched server-side; readable text extracted |
| **Topic** (typed or spoken) | Speak it in any language via **Saaras**; the hosts teach it from general knowledge |

Three one-click samples are included: an English UPI explainer, a Hindi Chandrayaan-3 text and a Tamil passage on the Thirukkural.

### 2. Choose how it sounds
- **Podcast language:** Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, English. The source and podcast languages can differ (Tamil document → Hindi podcast).
- **Format:**
  - *Chai pe Charcha*: two friends chatting over chai
  - *Exam Revision*: a topper helps a junior revise, ending with a quick-fire recap quiz
  - *Explain like I'm 10*: an elder sibling explains with everyday analogies
  - *Debate*: one host argues for, the other against
- **Length:** Quick (~1.5 min), Standard (~3 min), Deep dive (~5 min).
- **Hosts:** pick any two of 36 Bulbul voices, with a ▶ preview button. Host gender is passed to the script writer so verbs are conjugated correctly in gendered languages like Hindi and Marathi.

### 3. Listen
- Playback starts as soon as the first line is voiced. Remaining lines are generated in the background, prioritised by distance from the playhead.
- Animated host avatars show who's speaking, and a segmented timeline is coloured per host and clickable.
- A live transcript highlights and auto-scrolls; tap any line to jump to it.
- Speed control (0.85× to 1.5×) and keyboard shortcuts: `Space`, `←`/`→`, `H`.
- **Subtitles:**
  - *Romanised*: the same words in Latin script, for people who speak the language but can't read it
  - *Translate*: into any of 22 Indian languages or English
- **Download** the full episode as a single WAV.

### 4. Raise your hand ✋
Press **Raise hand** (or `H`) and ask anything, in any language, or type it. Behind the scenes:
1. **Saaras v4** transcribes and identifies your language, biased toward the episode's key terms (e.g. "Pragyan", "Thiruvalluvar") for accurate recognition.
2. **Mayura** translates your question into the episode's language.
3. **Sarvam-105B Conversations** writes a short on-air response: one host acknowledges you ("a listener just asked in Tamil…"), the answer is grounded in the source document, and the last line hands back to the show.
4. **Bulbul** voices it. The question and answer are inserted into the transcript, and playback resumes from where you left off.

Round trip is ~2–3 seconds.

### 5. Under the hood panel
A live dashboard of all 9 Sarvam models. Each card lights up when its model is called and shows call count and average latency. An activity log lists every call (model · task · time).

---

## Sarvam models used (9)

| # | Model | API | Role in Charcha |
|---|---|---|---|
| 1 | **Sarvam Vision** | `POST /doc-ai/v1/job/digitise` | OCR for PDFs and photos in 23 languages |
| 2 | **Language ID** | `POST /text-lid` | Detects the language and script of sources and typed questions |
| 3 | **Sarvam-105B** | `POST /v1/chat/completions` | Writes the full episode script as structured JSON |
| 4 | **Transliterate** | `POST /transliterate` | Native spelling of show and host names; romanised subtitles |
| 5 | **Bulbul v3** | `POST /text-to-speech` | Voices both hosts |
| 6 | **Saaras v4** | `POST /speech-to-text` | Transcribes spoken topics and questions (auto language detect, keyterm biasing) |
| 7 | **Mayura v1** | `POST /translate` | Translates the listener's question; colloquial subtitles for the 11 major languages |
| 8 | **Sarvam-105B Conversations** | `POST /v1/chat/completions` | Low-latency live answers from the hosts |
| 9 | **Sarvam-Translate v1** | `POST /translate` | Subtitles in all 22 scheduled languages (Urdu, Assamese, Santali, …) |

---

## How it works

```
 PDF / photo ──► Sarvam Vision ─┐
 Link ─────────► HTML → text ───┼─► Language ID ─┐
 Pasted text ───────────────────┘                │
 Spoken topic ─► Saaras v4 ──────────────────────┤
                                                 ▼
                 Transliterate (host names) ─► Sarvam-105B ─► script JSON
                                                 │
                                                 ▼
                      Bulbul v3, line by line (3 in parallel) ─► player
                                                 │
   ✋ voice question ─► Saaras v4 ─► Mayura ─► 105B Conversations ─► Bulbul ─► inserted live
                                                 │
   Subtitles ─► Transliterate (romanised) / Mayura · Sarvam-Translate (translated)
```

**Design notes**
- **Reasoning is disabled** for script writing. With reasoning on, Sarvam-105B spent ~2,500 tokens and ~15 s thinking. With it off, scripts arrive in ~3 s at comparable quality.
- **Questions are translated before reaching the LLM.** Without this, a question asked in Tamil got a Tamil answer even in a Hindi episode.
- **Names are transliterated up front.** The LLM otherwise misspelled host names in Devanagari (e.g. "शभ" for "शुभ").
- The server is stateless. The browser holds the episode and sends the needed context with each question.
- Every Sarvam call returns a `{model, task, ms}` trace that drives the Under the hood panel.
- Calls retry with backoff on 429/5xx.

---

## Project structure

```
server.js          Express server and API routes
lib/sarvam.js      Sarvam API client (chat, TTS, STT, translate, transliterate, LID, Vision) with retry and tracing
lib/prompts.js     Prompt builders for the script writer and the live Q&A hosts
lib/catalog.js     Languages, voices, formats, lengths
lib/unzip.js       Tiny ZIP reader for Sarvam Vision output
public/index.html  UI
public/styles.css  Styles (light and dark themes, responsive)
public/app.js      Player, TTS scheduler, recording, subtitles, WAV export, model dashboard
public/content.js  Demo samples, voice-preview lines, role labels
```

### API routes
| Route | Purpose |
|---|---|
| `GET /api/config` | Languages, voices, formats |
| `POST /api/extract/file` | PDF/image → text (Vision + LID) |
| `POST /api/extract/url` | Web page → text (+ LID) |
| `POST /api/detect` | Language ID for pasted text |
| `POST /api/stt` | Voice → text (Saaras) |
| `POST /api/script` | Generate episode script (Transliterate + 105B) |
| `POST /api/tts` | Voice one line (Bulbul) |
| `POST /api/ask` | Raise-hand Q&A (Saaras/LID → Mayura → 105B Conversations) |
| `POST /api/subtitles` | Romanise or translate transcript lines |

---

## Run it

Requires **Node.js 20.12+**.

```bash
npm install
npm start
```

Put your Sarvam key in `.env` first:
```
API_KEY=your_sarvam_key        # SARVAM_API_KEY also works
```

Open **http://localhost:3000** in Chrome or Edge, and allow microphone access when asked. To use another port: `$env:PORT=3001; npm start` (PowerShell).

---

## Demo script (60 seconds)

1. **Paste** tab → click the **திருக்குறள்** sample (Tamil) → choose **हिन्दी** → **Start the Charcha**.
2. While it plays: **Subtitles → Romanised**, then **Translate → English** (or Urdu, to show Sarvam-Translate).
3. Press **Raise hand**, ask *"Who wrote this and why is it called a universal text?"* in English or Tamil → **Send question**. The hosts answer in Hindi.
4. Scroll to **Under the hood** to show all models lit up with latencies.
5. Optional: **Upload** a photo of a textbook page to show Sarvam Vision.

---

## Limitations
- PDFs are limited to 10 pages (Sarvam Vision per-job limit); sources are capped at 24,000 characters for the script.
- Podcasts can be spoken in Bulbul's 11 languages. Sources, questions and subtitles work across all 22 scheduled languages.
- Topic-only episodes rely on the model's general knowledge rather than a source.
- Hackathon build: no auth, persistence or rate limiting.

Built on [Sarvam AI](https://www.sarvam.ai) for the Sarvam campus build-a-thon.
