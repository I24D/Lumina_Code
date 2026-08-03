/**
 * RecallEngine — single entry point for "search my memory".
 *
 * Picks the backend at construction time:
 *   - If `mem0BaseUrl` is provided in config, use the mem0 HTTP adapter.
 *   - Otherwise use the in-process BM25 over the FactStore.
 *
 * The engine never falls back implicitly. If mem0 is configured but
 * unreachable the recall returns an error to the caller — silent fallback
 * to a different backend would make the user think they're getting
 * semantic recall when they're actually getting keyword matching.
 */
import { Mem0Adapter } from "../adapters/mem0-adapter.js";
import { buildBm25Index, tokenize } from "./bm25.js";
import type { FactStore } from "../storage/fact-store.js";
import type { RecallHit, RecallResult } from "../types.js";

export type RecallEngineConfig = {
  readonly mem0BaseUrl?: string;
  readonly mem0ApiKey?: string;
  readonly recallLimitDefault: number;
};

export class RecallEngine {
  private readonly mem0: Mem0Adapter | null;

  constructor(
    private readonly facts: FactStore,
    private readonly config: RecallEngineConfig,
  ) {
    if (config.mem0BaseUrl) {
      this.mem0 = new Mem0Adapter({
        baseUrl: config.mem0BaseUrl,
        apiKey: config.mem0ApiKey,
      });
    } else {
      this.mem0 = null;
    }
  }

  /** Returns `null` when no backend can answer (e.g. mem0 is configured
   *  but unreachable). Callers must surface that to the user. */
  async recall(query: string, limit?: number): Promise<RecallResult | null> {
    const cap = Math.max(1, Math.min(100, limit ?? this.config.recallLimitDefault));
    if (this.mem0 !== null) {
      return this.mem0.recall(query, cap);
    }
    return this.bm25Recall(query, cap);
  }

  private bm25Recall(query: string, limit: number): RecallResult {
    const all = this.facts.list();
    const search = buildBm25Index(
      all.map((f) => ({ id: f.id, tokens: tokenize(f.text + " " + f.tags.join(" ")) })),
    );
    const bm25Hits = search(query, limit);

    // Boost by stored importance: a fact rated 5 gets a small uplift.
    // Cap the boost so it never flips a clearly-relevant hit out of the top.
    const byId = new Map(all.map((f) => [f.id, f]));
    const hits: RecallHit[] = bm25Hits
      .map((h) => {
        const fact = byId.get(h.id);
        if (!fact) return null;
        const importanceBoost = 1 + (fact.importance - 3) * 0.05; // ±10%
        return {
          fact,
          score: Math.max(0, Math.min(1, h.normalisedScore * importanceBoost)),
          source: "bm25" as const,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    return {
      hits,
      backend: "bm25",
      scanned: all.length,
    };
  }
}
