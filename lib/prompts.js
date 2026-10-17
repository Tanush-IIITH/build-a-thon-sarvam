// Prompt builders for the script writer (Sarvam-105B) and the live Q&A hosts
// (Sarvam-105B Conversations).
import { STYLES, LENGTHS, languageByCode, voiceById } from './catalog.js';

export const MAX_SOURCE_CHARS = 24_000;
const MAX_QA_SOURCE_CHARS = 12_000;

function hostLines(hosts, style) {
  return hosts
    .map((h, i) => `- ${h.name} (${h.gender}): ${STYLES[style].roles[i]}`)
    .join('\n');
}

function languageRule(lang, hosts, names) {
  const english = lang.code === 'en-IN';
  if (english) return 'Write every line in natural, spoken Indian English.';
  const spelling = names
    ? ` Inside the text, spell the show's name as "${names.show}" and the hosts' names as "${names.hosts[0]}" (${hosts[0].name}) and "${names.hosts[1]}" (${hosts[1].name}).`
    : '';
  return `Write every line in natural, spoken ${lang.name} using ${lang.script} script, the way educated young Indians actually talk. ` +
    `Common English words (technology, science, brand names) may stay in English where that is how people really speak. ` +
    `Use the correct grammatical gender for each host: ${hosts.map((h) => `${h.name} is ${h.gender}`).join(', ')}.${spelling}`;
}

export function scriptMessages({ source, topic, language, style, length, hostIds, names }) {
  const lang = languageByCode(language);
  const hosts = hostIds.map(voiceById);
  const { lines } = LENGTHS[length];
  const grounded = Boolean(source);

  const system = `You are the head writer of "Charcha", a podcast that turns documents into gripping conversations in Indian languages.

HOSTS
${hostLines(hosts, style)}

FORMAT: ${STYLES[style].label}. ${STYLES[style].brief}

LANGUAGE
${languageRule(lang, hosts, names)}

RULES
- Write about ${lines} lines in total. Hosts alternate naturally; each line is 1 to 3 spoken sentences and under 300 characters.
- ${grounded
    ? 'Stay faithful to the SOURCE. Do not invent facts, numbers, names or quotes that are not in it.'
    : 'There is no source document: teach the TOPIC using only well-established knowledge. Avoid precise statistics you are not sure of.'}
- Line 1 greets the listeners of Charcha and opens with a hook (a surprising fact, a question or a relatable moment).
- Hosts react to each other, ask follow-ups and build on what was just said, like a real conversation.
- The final line wraps up with a crisp takeaway and a sign-off.
- This will be read aloud by a text-to-speech engine: no stage directions, no markdown, no emojis, no bullet points, and never put a speaker name at the start of the text. Write numbers above 9,999 with commas.

Return ONLY a JSON object:
{
  "title": "a catchy episode title in ${lang.name}",
  "summary": "a 2-sentence summary of the episode, in English",
  "keyterms": ["up to 15 key names and terms from the material, as they would be spoken"],
  "lines": [{"speaker": "${hosts[0].name}" or "${hosts[1].name}", "text": "..."}]
}`;

  const user = grounded
    ? `SOURCE:\n<<<\n${source.slice(0, MAX_SOURCE_CHARS)}\n>>>\n\nWrite the episode in ${lang.name}.`
    : `TOPIC: ${topic}\n\nWrite the episode in ${lang.name}.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function answerMessages({ question, originalQuestion, questionLanguage, source, topic, title, language, style, hostIds, names, recentLines }) {
  const lang = languageByCode(language);
  const hosts = hostIds.map(voiceById);
  const asked = languageByCode(questionLanguage);

  const system = `You are ${hosts[0].name} and ${hosts[1].name}, live hosts of the Charcha podcast episode "${title}" (${STYLES[style].label} format).

${hostLines(hosts, style)}

A listener just raised their hand mid-episode and asked a question. Respond on air:
- One host briefly acknowledges the listener${asked && asked.code !== language ? ` (who asked in ${asked.name})` : ''} and restates the question in a few words.
- Answer it clearly and correctly, grounded in the SOURCE below. If the source does not cover it, say so honestly, then share only what you are confident is true.
- Use 2 to 4 short lines in total, alternating hosts. The last line smoothly hands back to the episode.
- ${languageRule(lang, hosts, names)} Always reply in ${lang.name}, whatever language the question was asked in.
- No stage directions, markdown or emojis. Never start a line with a speaker name.

Return ONLY JSON: {"lines": [{"speaker": "${hosts[0].name}" or "${hosts[1].name}", "text": "..."}]}

SOURCE:
<<<
${source ? source.slice(0, MAX_QA_SOURCE_CHARS) : `(No document. Episode topic: ${topic})`}
>>>

LAST FEW LINES OF THE EPISODE:
${recentLines.map((l) => `${l.speaker}: ${l.text}`).join('\n')}`;

  const user =
    originalQuestion && originalQuestion !== question
      ? `Listener's question (asked in ${asked?.name || 'another language'}): "${originalQuestion}"\nIn ${lang.name}: "${question}"\n\nReply in ${lang.name}.`
      : `Listener's question: "${question}"\n\nReply in ${lang.name}.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Normalises LLM-produced lines: valid speakers, no "Name:" prefixes, sane length. */
export function cleanLines(rawLines, hostIds) {
  const names = hostIds.map((id) => voiceById(id).name);
  return (Array.isArray(rawLines) ? rawLines : [])
    .map((l, i) => {
      let text = String(l?.text ?? '').trim();
      for (const n of names) text = text.replace(new RegExp(`^${n}\\s*[:：-]\\s*`, 'i'), '');
      text = text.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 900);
      const idx = names.findIndex((n) => n.toLowerCase() === String(l?.speaker ?? '').trim().toLowerCase());
      return { host: idx >= 0 ? idx : i % 2, text };
    })
    .filter((l) => l.text);
}
