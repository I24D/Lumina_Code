/**
 * set-of-marks.ts — SoM-style overlay helper for vision-grounded replay.
 *
 * Given a list of detected elements (from lumina_vision_parse or
 * lumina_vision_ui_tree), produces:
 *
 *   - a numbered overlay description suitable for inclusion in an LLM
 *     prompt: "Element 1: 'Save' button at (842,567); Element 2: ..."
 *   - a lookup index from "1" → element, so when the LLM answers
 *     'click element 7' we resolve to the actual bbox+center.
 *
 * Why SoM: asking an LLM "where's the Save button at?" makes it invent
 * coordinates. Numbering elements and asking "which number?" turns the
 * task into multiple-choice — much more reliable. See OpenAdapt
 * Grounding + GPT-4V Set-of-Marks papers.
 */

export type DetectedElement = {
  readonly kind?: string;
  readonly label?: string | null;
  readonly bbox: { x: number; y: number; w: number; h: number };
  readonly center?: { x: number; y: number };
  readonly confidence?: number;
  readonly source?: string;
};

export type SetOfMarks = {
  readonly description: string;
  readonly index: ReadonlyMap<string, DetectedElement>;
  readonly count: number;
};

export function buildSetOfMarks(
  elements: ReadonlyArray<DetectedElement>,
  opts: {
    readonly maxElements?: number;
    readonly includeIcons?: boolean;
    readonly includeText?: boolean;
    readonly minConfidence?: number;
  } = {},
): SetOfMarks {
  const maxElements = opts.maxElements ?? 30;
  const minConfidence = opts.minConfidence ?? 0;
  const filtered = elements.filter((e) => {
    if (typeof e.confidence === "number" && e.confidence < minConfidence) return false;
    if (opts.includeIcons === false && e.kind === "icon") return false;
    if (opts.includeText === false && e.kind === "text") return false;
    return true;
  });
  // Stable sort: top-to-bottom, left-to-right (reading order).
  const sorted = [...filtered].sort((a, b) => {
    const aRow = Math.floor(a.bbox.y / 32);
    const bRow = Math.floor(b.bbox.y / 32);
    if (aRow !== bRow) return aRow - bRow;
    return a.bbox.x - b.bbox.x;
  }).slice(0, maxElements);

  const lines: string[] = [];
  const index = new Map<string, DetectedElement>();
  sorted.forEach((el, i) => {
    const id = String(i + 1);
    index.set(id, el);
    const center = el.center ?? {
      x: el.bbox.x + Math.floor(el.bbox.w / 2),
      y: el.bbox.y + Math.floor(el.bbox.h / 2),
    };
    const label = (el.label ?? "(no label)").replace(/\s+/g, " ").slice(0, 80);
    const conf = typeof el.confidence === "number" ? ` conf=${el.confidence.toFixed(2)}` : "";
    lines.push(
      `${id}. [${el.kind ?? "elem"}] "${label}" at (${center.x},${center.y}) ` +
        `size ${el.bbox.w}x${el.bbox.h}${conf}`,
    );
  });
  return {
    description: lines.join("\n"),
    index,
    count: sorted.length,
  };
}

/**
 * Parse an LLM answer like "Element 7" or "I would click 7" or just "7"
 * and return the bbox+center for that ordinal, or null if it doesn't
 * resolve.
 */
export function resolveSetOfMarksChoice(answer: string, marks: SetOfMarks): DetectedElement | null {
  if (!answer) return null;
  const match = answer.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  const key = match[1]!;
  return marks.index.get(key) ?? null;
}
