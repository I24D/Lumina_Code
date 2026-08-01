/**
 * Spoken confirmation / decline detection for Start Talk.
 *
 * After Start Talk reads a reply-eligible notification aloud it asks, in one
 * short sentence, whether the user wants it to reply (e.g. "¿Quieres que le
 * responda?"). This module turns the user's spoken answer into a deterministic
 * yes / no decision so the app itself can delegate the reply to the Lumina Code
 * chat — without relying on the voice model to guess. Matching is
 * accent-insensitive and case-insensitive and works in Spanish and English.
 */

/** Whole-utterance affirmations ("sí", "ok", "dale", "me parece bien", ...). */
export const AFFIRMATIVE_PHRASES: readonly string[] = [
  // Spanish – plain yes
  "si",
  "sip",
  "sii",
  "simon",
  "sipi",
  "claro",
  "claro que si",
  "por supuesto",
  "obvio",
  "afirmativo",
  "exacto",
  "correcto",
  // Spanish – ok / go
  "ok",
  "oka",
  "okey",
  "okay",
  "vale",
  "dale",
  "va",
  "va que va",
  "de una",
  "orale",
  "perfecto",
  "genial",
  // Spanish – "yes please" / "sounds good"
  "si por favor",
  "si porfa",
  "porfa",
  "por favor",
  "me parece bien",
  "me parece",
  "esta bien",
  "esta bueno",
  "suena bien",
  "buena idea",
  "hagamoslo",
  // Spanish – explicit "do it / reply"
  "hazlo",
  "hazlo por favor",
  "adelante",
  "procede",
  // English
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok please",
  "go ahead",
  "do it",
  "please do",
  "sounds good",
];

/**
 * Imperative "reply" verbs. When any of these appears anywhere in a short
 * utterance it is a clear instruction to answer the message ("respondele",
 * "contestale", "mandale que ya voy", "dile que si").
 */
export const REPLY_VERB_TOKENS: readonly string[] = [
  "responde",
  "respondele",
  "respondele que",
  "contesta",
  "contestale",
  "mandale",
  "mandale que",
  "escribele",
  "escribele que",
  "dile",
  "dile que",
  "contestale que",
  "reply",
  "answer",
  "tell her",
  "tell him",
  "tell them",
];

/** Whole-utterance declines ("no", "ahora no", "dejalo", ...). */
export const NEGATIVE_PHRASES: readonly string[] = [
  "no",
  "nel",
  "nop",
  "nope",
  "no gracias",
  "no por favor",
  "para nada",
  "ahora no",
  "todavia no",
  "aun no",
  "mejor no",
  "no por ahora",
  "dejalo",
  "dejalo asi",
  "olvidalo",
  "cancela",
  "cancelar",
  "no respondas",
  "no le respondas",
  "no contestes",
  "not now",
  "cancel",
  "never mind",
  "nevermind",
  "dont",
  "do not",
];

const MAX_CONFIRMATION_WORDS = 8;

/** Lowercase, strip accents/diacritics and punctuation, collapse whitespace. */
export function normalizeSpokenReply(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function wordCount(normalized: string): number {
  return normalized ? normalized.split(" ").length : 0;
}

/** Does the utterance start with one of the given phrases (word-aligned)? */
function startsWithPhrase(
  normalized: string,
  phrases: readonly string[],
): boolean {
  return phrases.some(
    (phrase) =>
      normalized === phrase || normalized.startsWith(`${phrase} `),
  );
}

function containsToken(
  normalized: string,
  tokens: readonly string[],
): boolean {
  const padded = ` ${normalized} `;
  return tokens.some((token) => padded.includes(` ${token} `));
}

/**
 * True when a short spoken utterance is a confirmation to reply. Only short
 * utterances are considered so a long sentence that merely happens to contain
 * "si" is not treated as a yes.
 */
export function isAffirmativeReply(value: string | undefined): boolean {
  const normalized = normalizeSpokenReply(value);
  if (!normalized || wordCount(normalized) > MAX_CONFIRMATION_WORDS) {
    return false;
  }
  // An explicit decline wins even if it also contains an affirmative token
  // (e.g. "no, mejor no le respondas").
  if (startsWithPhrase(normalized, NEGATIVE_PHRASES)) {
    return false;
  }
  return (
    startsWithPhrase(normalized, AFFIRMATIVE_PHRASES) ||
    containsToken(normalized, REPLY_VERB_TOKENS)
  );
}

/** True when a short spoken utterance declines the reply. */
export function isNegativeReply(value: string | undefined): boolean {
  const normalized = normalizeSpokenReply(value);
  if (!normalized || wordCount(normalized) > MAX_CONFIRMATION_WORDS) {
    return false;
  }
  return startsWithPhrase(normalized, NEGATIVE_PHRASES);
}
