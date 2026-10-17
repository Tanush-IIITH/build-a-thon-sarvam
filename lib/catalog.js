// Languages, voices, styles and lengths. Served to the browser via /api/config.

// Languages Bulbul can speak, so these are the podcast languages.
export const PODCAST_LANGUAGES = [
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी', script: 'Devanagari' },
  { code: 'bn-IN', name: 'Bengali', native: 'বাংলা', script: 'Bengali' },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்', script: 'Tamil' },
  { code: 'te-IN', name: 'Telugu', native: 'తెలుగు', script: 'Telugu' },
  { code: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ', script: 'Kannada' },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം', script: 'Malayalam' },
  { code: 'mr-IN', name: 'Marathi', native: 'मराठी', script: 'Devanagari' },
  { code: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી', script: 'Gujarati' },
  { code: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', script: 'Gurmukhi' },
  { code: 'od-IN', name: 'Odia', native: 'ଓଡ଼ିଆ', script: 'Odia' },
  { code: 'en-IN', name: 'English', native: 'English', script: 'Latin' },
];

// The remaining scheduled languages: readable by Sarvam Vision and Saaras,
// translatable by Sarvam-Translate, but not (yet) speakable by Bulbul.
export const EXTRA_LANGUAGES = [
  { code: 'as-IN', name: 'Assamese', native: 'অসমীয়া' },
  { code: 'ur-IN', name: 'Urdu', native: 'اردو' },
  { code: 'ne-IN', name: 'Nepali', native: 'नेपाली' },
  { code: 'kok-IN', name: 'Konkani', native: 'कोंकणी' },
  { code: 'ks-IN', name: 'Kashmiri', native: 'کٲشُر' },
  { code: 'sd-IN', name: 'Sindhi', native: 'سنڌي' },
  { code: 'sa-IN', name: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'sat-IN', name: 'Santali', native: 'ᱥᱟᱱᱛᱟᱲᱤ' },
  { code: 'mni-IN', name: 'Manipuri', native: 'মৈতৈলোন্' },
  { code: 'brx-IN', name: 'Bodo', native: 'बड़ो' },
  { code: 'mai-IN', name: 'Maithili', native: 'मैथिली' },
  { code: 'doi-IN', name: 'Dogri', native: 'डोगरी' },
];

export const ALL_LANGUAGES = [...PODCAST_LANGUAGES, ...EXTRA_LANGUAGES];
export const MAYURA_LANGS = new Set(PODCAST_LANGUAGES.map((l) => l.code));
export const languageByCode = (code) => ALL_LANGUAGES.find((l) => l.code === code);

// Bulbul v3 speakers. Gender matters: Hindi, Marathi, Punjabi etc. conjugate
// verbs by the speaker's gender, so the script writer must know it.
// (varun is omitted: Sarvam recommends it only for drama/thrillers.)
const FEMALE = ['ishita', 'priya', 'kavya', 'neha', 'ritu', 'pooja', 'simran', 'shreya', 'roopa', 'tanya', 'shruti', 'suhani', 'kavitha', 'rupali'];
const MALE = ['shubh', 'rahul', 'aditya', 'rohan', 'amit', 'dev', 'ratan', 'manan', 'sumit', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'mohit', 'rehan', 'soham'];
const titleCase = (s) => s[0].toUpperCase() + s.slice(1);
export const VOICES = [
  ...FEMALE.map((id) => ({ id, name: titleCase(id), gender: 'female' })),
  ...MALE.map((id) => ({ id, name: titleCase(id), gender: 'male' })),
];
export const voiceById = (id) => VOICES.find((v) => v.id === id);
export const DEFAULT_HOSTS = ['shubh', 'ishita'];

export const STYLES = {
  chai: {
    label: 'Chai pe Charcha',
    blurb: 'Two friends, one cutting chai',
    roles: ['the curious friend who asks what listeners are wondering', 'the friend who has studied the material closely and explains it'],
    brief: 'A warm, witty conversation between two friends over chai. Use relatable everyday Indian examples and analogies, light humour and genuine curiosity.',
  },
  exam: {
    label: 'Exam Revision',
    blurb: 'A topper helps you revise',
    roles: ['a junior student revising for an exam', 'a senior topper who knows exactly what examiners ask'],
    brief: 'A focused revision session. Highlight definitions, key facts, dates, numbers and cause-and-effect links. Give one memorable mnemonic or trick. End with a quick-fire recap where the senior asks 3 short questions and the junior answers them correctly.',
  },
  eli10: {
    label: 'Explain like I’m 10',
    blurb: 'Big ideas, small words',
    roles: ['a curious 10-year-old', 'a patient elder sibling'],
    brief: 'The elder sibling explains everything in simple words with vivid analogies from a child’s world (cricket, school, tiffin, cartoons, festivals). Never use jargon without immediately explaining it. The child asks naive but sharp questions.',
  },
  debate: {
    label: 'Debate',
    blurb: 'Two sides, one mic',
    roles: ['the optimist who argues in favour', 'the sceptic who argues against'],
    brief: 'A spirited but respectful debate. Each host takes a clear side on the questions the source raises, backs claims with evidence from it, and rebuts the other. End by naming what they both agree on.',
  },
};

export const LENGTHS = {
  short: { label: 'Quick', lines: 8, approx: '~1.5 min' },
  medium: { label: 'Standard', lines: 14, approx: '~3 min' },
  long: { label: 'Deep dive', lines: 22, approx: '~5 min' },
};
