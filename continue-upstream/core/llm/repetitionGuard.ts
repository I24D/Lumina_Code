/**
 * Detects a model response stuck echoing itself.
 *
 * Ported from Hermes's repetition guard, which exists because of a concrete
 * failure: a model spent its whole output budget repeating one fragment and
 * produced tens of thousands of characters of the same text. Left alone this
 * burns the budget, floods the transcript, and — because the transcript goes
 * back to the model next turn — poisons the context that follows.
 *
 * The hard part is telling a loop apart from legitimate repetition. Code
 * review output repeats file paths, a table repeats its columns, a long list
 * repeats its boilerplate. Hermes measures whether repeats of one 60-char
 * window "cover" half the text, but overlapping windows make that fire on a
 * two-hundred-row list whose rows share a phrase — legitimate output that must
 * not be aborted. Two things separate a genuine loop instead:
 *
 *   1. It is *long*. A short response that repeats itself costs nothing.
 *   2. It is *periodic*. In a real loop the repeated unit is nearly the whole
 *      text, so successive occurrences sit right next to each other. In a list
 *      with shared boilerplate they are separated by the parts that vary.
 *
 * Both must hold, which is the right bias for a guard whose action is to throw
 * away a response the user was waiting for.
 */

/** Long enough that ordinary phrasing does not repeat verbatim at this size. */
const WINDOW_CHARS = 60;

/**
 * Below this a response is not a problem worth aborting over, however
 * repetitive. It also keeps the guard off the hot path for every normal
 * answer: a genuine loop blows past this within moments.
 */
export const MIN_RESPONSE_CHARS = 20_000;

/** Fewer repeats than this is a pattern, not a loop. */
const MIN_REPEATS = 5;

/** Repeats must account for this much of the response. */
const DOMINANCE = 0.85;

/**
 * How far apart two occurrences may sit and still count as a tight loop.
 * Slightly above the window size: in a real loop the gap between occurrences
 * is the length of the repeated unit itself.
 */
const MAX_LOOP_PERIOD = WINDOW_CHARS * 1.2;

/** How much new text to accumulate between checks while streaming. */
export const REPETITION_CHECK_INTERVAL_CHARS = 8_000;

export const REPETITION_ERROR_MESSAGE =
  "The model got stuck repeating itself and the response was stopped. " +
  "Try again, and consider rephrasing or starting a new session if this " +
  "conversation has grown very long.";

/**
 * A window that is one character repeated — a run of newlines, base64 padding,
 * a rule of dashes — is formatting, not the model looping on an idea.
 */
function isLowInformation(window: string): boolean {
  const first = window[0];
  for (let index = 1; index < window.length; index++) {
    if (window[index] !== first) {
      return false;
    }
  }
  return true;
}

/**
 * One line repeated until it is most of the response.
 *
 * Coverage here is exact — the line length is known — which is why this pass
 * carries the strict threshold and catches the overwhelming majority of real
 * loops, since models loop on whole lines.
 */
function hasDominantLine(text: string, threshold: number): boolean {
  const counts = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const next = (counts.get(line) ?? 0) + 1;
    counts.set(line, next);
    if (next >= MIN_REPEATS && next * line.length >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * A tight loop with no line breaks to key off.
 *
 * Requires both that the occurrences span most of the response and that they
 * sit close together. The second condition is what a list of distinct rows
 * sharing a phrase fails: its repeats are spread out by the content between
 * them, so the period is far wider than the fragment.
 */
function hasPeriodicWindow(text: string, threshold: number): boolean {
  const seen = new Map<
    string,
    { count: number; first: number; last: number }
  >();

  for (let index = 0; index + WINDOW_CHARS <= text.length; index++) {
    const window = text.slice(index, index + WINDOW_CHARS);
    if (isLowInformation(window)) {
      continue;
    }
    const entry = seen.get(window);
    if (!entry) {
      seen.set(window, { count: 1, first: index, last: index });
      continue;
    }
    entry.count += 1;
    entry.last = index;

    if (entry.count < MIN_REPEATS) {
      continue;
    }
    const span = entry.last - entry.first + WINDOW_CHARS;
    const period = (entry.last - entry.first) / (entry.count - 1);
    if (period <= MAX_LOOP_PERIOD && span >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * True when `text` is a long response dominated by one repeated fragment.
 */
export function isRepetitionLoop(text: string): boolean {
  if (text.length < MIN_RESPONSE_CHARS) {
    return false;
  }
  const threshold = text.length * DOMINANCE;
  return (
    hasDominantLine(text, threshold) || hasPeriodicWindow(text, threshold)
  );
}
