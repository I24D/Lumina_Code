/**
 * Minimal BM25 ranking for FactStore.
 *
 * Why BM25 and not embeddings: in Phase 2 we want a zero-dependency,
 * deterministic baseline that runs fast on personal-scale data
 * (thousands of facts). It's also much easier to debug than a vector
 * store. When the user opts into mem0 (`mem0BaseUrl`), recall switches
 * to that backend — see the adapter.
 *
 * Implementation notes:
 *   - Tokenizer is intentionally simple: lowercase, split on
 *     non-alphanumeric, drop tokens of length < 2.
 *   - Stop words list is short and conservative. We don't want to drop
 *     names like "dal".
 *   - Parameters k1 and b are the textbook defaults (1.5, 0.75).
 *   - Score is normalised to [0, 1] across the result set before return
 *     so callers can compare relative confidence.
 */

const STOP_WORDS = new Set([
  // Spanish + English minimal set. Avoid removing anything that looks like
  // a name. Bias toward FALSE POSITIVES (kept) over false negatives (dropped).
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "it", "for", "on", "by",
  "el", "la", "los", "las", "de", "del", "y", "o", "es", "un", "una", "en", "por",
]);

const TOKEN_RE = /[a-z0-9áéíóúüñ]+/gi;

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const out: string[] = [];
  for (const match of lowered.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

export type Bm25Doc = {
  readonly id: string;
  readonly tokens: ReadonlyArray<string>;
};

export type Bm25Hit = {
  readonly id: string;
  readonly rawScore: number;
  readonly normalisedScore: number;
};

/**
 * Build a sortable index once over the corpus. Returns a function that
 * takes a query string and returns ranked hits. We keep the doc tokens
 * already lowercased so callers control tokenization consistency.
 */
export function buildBm25Index(docs: ReadonlyArray<Bm25Doc>): (query: string, limit: number) => Bm25Hit[] {
  const N = docs.length || 1;
  const k1 = 1.5;
  const b = 0.75;

  // Document length and average.
  const docLens = docs.map((d) => d.tokens.length);
  const avgLen = docLens.reduce((a, c) => a + c, 0) / N;

  // Document frequency per token.
  const df = new Map<string, number>();
  for (const d of docs) {
    const seen = new Set<string>();
    for (const t of d.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // Term frequency per (doc, token).
  const tf: Array<Map<string, number>> = docs.map((d) => {
    const m = new Map<string, number>();
    for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });

  function idf(token: string): number {
    const dfT = df.get(token) ?? 0;
    // BM25 idf with +1 smoothing to keep scores non-negative.
    return Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
  }

  return function search(query: string, limit: number): Bm25Hit[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored: Array<{ id: string; score: number }> = new Array(docs.length);
    for (let i = 0; i < docs.length; i++) {
      const dl = docLens[i] ?? 1;
      const tfMap = tf[i];
      if (!tfMap) {
        scored[i] = { id: docs[i]!.id, score: 0 };
        continue;
      }
      let s = 0;
      for (const qt of queryTokens) {
        const f = tfMap.get(qt) ?? 0;
        if (f === 0) continue;
        const num = f * (k1 + 1);
        const den = f + k1 * (1 - b + (b * dl) / (avgLen || 1));
        s += idf(qt) * (num / (den || 1));
      }
      scored[i] = { id: docs[i]!.id, score: s };
    }

    scored.sort((a, b2) => b2.score - a.score);
    const trimmed = scored.slice(0, Math.max(1, limit));
    const max = trimmed[0]?.score ?? 0;
    return trimmed
      .filter((h) => h.score > 0)
      .map((h) => ({
        id: h.id,
        rawScore: h.score,
        normalisedScore: max > 0 ? h.score / max : 0,
      }));
  };
}
