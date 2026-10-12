// A lenient guess at whether a title could be in a language, from the letters it uses.
// It never decides what language a title *is*: it only rules titles out when their letters
// could not belong to the language (Cyrillic for English, Latin only for Japanese, many
// letters missing from the language's alphabet…). Browser-safe.

type Script =
  | 'Latin'
  | 'Cyrillic'
  | 'Greek'
  | 'Arabic'
  | 'Hebrew'
  | 'Devanagari'
  | 'Bengali'
  | 'Gurmukhi'
  | 'Gujarati'
  | 'Tamil'
  | 'Telugu'
  | 'Kannada'
  | 'Malayalam'
  | 'Sinhala'
  | 'Thai'
  | 'Lao'
  | 'Khmer'
  | 'Myanmar'
  | 'Georgian'
  | 'Armenian'
  | 'Ethiopic'
  | 'Hangul'
  | 'Hiragana'
  | 'Katakana'
  | 'Han'
  | 'Bopomofo';

const SCRIPTS: Script[] = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Arabic',
  'Hebrew',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Thai',
  'Lao',
  'Khmer',
  'Myanmar',
  'Georgian',
  'Armenian',
  'Ethiopic',
  'Hangul',
  'Hiragana',
  'Katakana',
  'Han',
  'Bopomofo',
];
const SCRIPT_TESTS = SCRIPTS.map((script) => [script, new RegExp(`^\\p{Script=${script}}$`, 'u')] as const);

export interface LanguageInfo {
  code: string;
  name: string;
  /** Scripts the language is written in. */
  scripts: Script[];
  /** For alphabets: the lower-case letters it uses (other letters of the script count against it). */
  letters?: string;
}

const AZ = 'abcdefghijklmnopqrstuvwxyz';
const RU = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';

/** Languages users can pick, in display order. */
export const LANGUAGES: LanguageInfo[] = [
  // English borrows words with accents (café, naïve, jalapeño, über), so those letters pass.
  { code: 'en', name: 'English', scripts: ['Latin'], letters: `${AZ}àáâäæçèéêëìíîïñòóôöœùúûüÿ` },
  { code: 'es', name: 'Español', scripts: ['Latin'], letters: `${AZ}áéíóúüñ` },
  { code: 'pt', name: 'Português', scripts: ['Latin'], letters: `${AZ}áâãàçéêíóôõúü` },
  { code: 'fr', name: 'Français', scripts: ['Latin'], letters: `${AZ}àâæçéèêëîïôœùûüÿ` },
  { code: 'de', name: 'Deutsch', scripts: ['Latin'], letters: `${AZ}äöüßé` },
  { code: 'it', name: 'Italiano', scripts: ['Latin'], letters: `${AZ}àèéìíîòóùú` },
  { code: 'nl', name: 'Nederlands', scripts: ['Latin'], letters: `${AZ}áéíóúäëïöüèà` },
  { code: 'sv', name: 'Svenska', scripts: ['Latin'], letters: `${AZ}åäöé` },
  { code: 'no', name: 'Norsk', scripts: ['Latin'], letters: `${AZ}æøåéèêóòô` },
  { code: 'da', name: 'Dansk', scripts: ['Latin'], letters: `${AZ}æøåé` },
  { code: 'fi', name: 'Suomi', scripts: ['Latin'], letters: `${AZ}äöåšž` },
  { code: 'pl', name: 'Polski', scripts: ['Latin'], letters: `${AZ}ąćęłńóśźż` },
  { code: 'cs', name: 'Čeština', scripts: ['Latin'], letters: `${AZ}áčďéěíňóřšťúůýž` },
  { code: 'sk', name: 'Slovenčina', scripts: ['Latin'], letters: `${AZ}áäčďéíĺľňóôŕšťúýž` },
  { code: 'hu', name: 'Magyar', scripts: ['Latin'], letters: `${AZ}áéíóöőúüű` },
  { code: 'ro', name: 'Română', scripts: ['Latin'], letters: `${AZ}ăâîșşțţ` },
  { code: 'hr', name: 'Hrvatski', scripts: ['Latin'], letters: `${AZ}čćđšž` },
  { code: 'sl', name: 'Slovenščina', scripts: ['Latin'], letters: `${AZ}čšž` },
  { code: 'lt', name: 'Lietuvių', scripts: ['Latin'], letters: `${AZ}ąčęėįšųūž` },
  { code: 'lv', name: 'Latviešu', scripts: ['Latin'], letters: `${AZ}āčēģīķļņšūž` },
  { code: 'et', name: 'Eesti', scripts: ['Latin'], letters: `${AZ}äöõüšž` },
  { code: 'tr', name: 'Türkçe', scripts: ['Latin'], letters: `${AZ}çğıöşüâîû` },
  { code: 'vi', name: 'Tiếng Việt', scripts: ['Latin'], letters: `${AZ}àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ` },
  { code: 'id', name: 'Bahasa Indonesia', scripts: ['Latin'], letters: `${AZ}é` },
  { code: 'ms', name: 'Bahasa Melayu', scripts: ['Latin'], letters: AZ },
  { code: 'tl', name: 'Filipino', scripts: ['Latin'], letters: `${AZ}ñ` },
  { code: 'sw', name: 'Kiswahili', scripts: ['Latin'], letters: AZ },
  { code: 'ru', name: 'Русский', scripts: ['Cyrillic'], letters: RU },
  { code: 'uk', name: 'Українська', scripts: ['Cyrillic'], letters: 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя' },
  { code: 'bg', name: 'Български', scripts: ['Cyrillic'], letters: 'абвгдежзийклмнопрстуфхцчшщъьюя' },
  { code: 'sr', name: 'Српски', scripts: ['Cyrillic', 'Latin'], letters: `абвгдђежзијклљмнњопрстћуфхцчџш${AZ}čćđšž` },
  { code: 'el', name: 'Ελληνικά', scripts: ['Greek'] },
  { code: 'ar', name: 'العربية', scripts: ['Arabic'] },
  { code: 'fa', name: 'فارسی', scripts: ['Arabic'] },
  { code: 'ur', name: 'اردو', scripts: ['Arabic'] },
  { code: 'he', name: 'עברית', scripts: ['Hebrew'] },
  { code: 'hi', name: 'हिन्दी', scripts: ['Devanagari'] },
  { code: 'mr', name: 'मराठी', scripts: ['Devanagari'] },
  { code: 'ne', name: 'नेपाली', scripts: ['Devanagari'] },
  { code: 'bn', name: 'বাংলা', scripts: ['Bengali'] },
  { code: 'pa', name: 'ਪੰਜਾਬੀ', scripts: ['Gurmukhi'] },
  { code: 'gu', name: 'ગુજરાતી', scripts: ['Gujarati'] },
  { code: 'ta', name: 'தமிழ்', scripts: ['Tamil'] },
  { code: 'te', name: 'తెలుగు', scripts: ['Telugu'] },
  { code: 'kn', name: 'ಕನ್ನಡ', scripts: ['Kannada'] },
  { code: 'ml', name: 'മലയാളം', scripts: ['Malayalam'] },
  { code: 'si', name: 'සිංහල', scripts: ['Sinhala'] },
  { code: 'th', name: 'ไทย', scripts: ['Thai'] },
  { code: 'lo', name: 'ລາວ', scripts: ['Lao'] },
  { code: 'km', name: 'ខ្មែរ', scripts: ['Khmer'] },
  { code: 'my', name: 'မြန်မာ', scripts: ['Myanmar'] },
  { code: 'ka', name: 'ქართული', scripts: ['Georgian'] },
  { code: 'hy', name: 'Հայերեն', scripts: ['Armenian'] },
  { code: 'am', name: 'አማርኛ', scripts: ['Ethiopic'] },
  { code: 'zh', name: '中文', scripts: ['Han', 'Bopomofo'] },
  { code: 'ja', name: '日本語', scripts: ['Hiragana', 'Katakana', 'Han'] },
  { code: 'ko', name: '한국어', scripts: ['Hangul', 'Han'] },
];

const BY_CODE = new Map(LANGUAGES.map((language) => [language.code, language]));

/** The language part of a code: "en-US" → "en". */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

/** Share of a title's letters that may fall outside the language before it is ruled out. */
const TOLERANCE = 0.2;

function scriptOf(char: string): Script | undefined {
  if (char < '\u0080') return 'Latin'; // (only letters get here)
  return SCRIPT_TESTS.find(([, test]) => test.test(char))?.[0];
}

/** The letters of a text (no digits, punctuation, emoji or combining marks), lower case. */
function lettersOf(text: string): string[] {
  return [...text.normalize('NFC').toLowerCase()].filter((char) => /\p{L}/u.test(char));
}

/**
 * Whether a text could be in a language. Texts without letters could be in any language;
 * unknown codes never rule anything out. Titles in non-Latin languages often carry Latin
 * words (names, brands), so for those Latin letters are neutral, but at least one letter
 * must be in the language's own script.
 */
export function couldBeLanguage(text: string, code: string): boolean {
  // Feeds check the same titles again and again.
  const key = `${code}\u0000${text}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const result = judge(text, code);
  if (memo.size >= 50_000) memo.clear();
  memo.set(key, result);
  return result;
}

const memo = new Map<string, boolean>();

function judge(text: string, code: string): boolean {
  const language = BY_CODE.get(baseLanguage(code));
  if (!language) return true;
  const letters = lettersOf(text);
  if (!letters.length) return true;
  const latinIsOwn = language.scripts.includes('Latin');
  let own = 0;
  let foreign = 0;
  for (const letter of letters) {
    const script = scriptOf(letter);
    if (script && language.scripts.includes(script)) {
      if (!language.letters || language.letters.includes(letter)) own++;
      else foreign++;
    } else if (script === 'Latin' && !latinIsOwn) {
      // neutral
    } else {
      foreign++;
    }
  }
  if (!latinIsOwn && own === 0) return false;
  return foreign <= letters.length * TOLERANCE;
}

/** Whether a text could be in any of the languages (an empty list allows everything). */
export function couldBeAnyLanguage(text: string, codes: readonly string[] | undefined): boolean {
  if (!codes?.length) return true;
  return codes.some((code) => couldBeLanguage(text, code));
}

/** Codes that say nothing about the language (undetermined, none, several, other). */
const UNDETERMINED = new Set(['und', 'zxx', 'mul', 'mis']);

/**
 * Whether content passes a language preference: content that declares its language must
 * declare one of them, other content is judged by its title.
 */
export function matchesLanguages(content: { title?: string; language?: string }, codes: readonly string[] | undefined): boolean {
  if (!codes?.length) return true;
  const wanted = new Set(codes.map(baseLanguage));
  const declared = content.language ? baseLanguage(content.language) : '';
  if (declared && !UNDETERMINED.has(declared)) return wanted.has(declared);
  return couldBeAnyLanguage(content.title ?? '', [...wanted]);
}
