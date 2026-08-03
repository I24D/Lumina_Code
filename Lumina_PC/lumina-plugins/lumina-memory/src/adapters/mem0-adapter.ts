/**
 * mem0 HTTP adapter — thin wrapper around the mem0 server REST API.
 *
 * This is OPTIONAL — only used when `mem0BaseUrl` is configured. mem0
 * runs as a separate process (typically Python) and we call it over
 * HTTP with a bearer token. We do not bundle mem0; the user spins it
 * up on their own machine (or remote with care) and points us at it.
 *
 * The shape below targets the published v1 search API. If mem0 changes,
 * adapt here without touching the recall engine.
 */
import type { RecallHit, RecallResult, StoredFact } from "../types.js";

export type Mem0AdapterOptions = {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
};

type Mem0SearchResponse = {
  readonly results?: ReadonlyArray<{
    readonly id?: string;
    readonly memory?: string;
    readonly score?: number;
    readonly created_at?: string;
    readonly metadata?: Record<string, unknown>;
  }>;
};

export class Mem0Adapter {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(opts: Mem0AdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? null;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  /** Returns `null` if mem0 fails so the caller can surface that explicitly. */
  async recall(query: string, limit: number): Promise<RecallResult | null> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/v1/memories/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Mem0SearchResponse;
      const results = data.results ?? [];
      const hits: RecallHit[] = results
        .filter((r): r is { id: string; memory: string } & typeof r =>
          typeof r.id === "string" && typeof r.memory === "string",
        )
        .map((r) => {
          const fact: StoredFact = {
            id: r.id,
            createdAtISO: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
            text: r.memory,
            source: "mem0",
            tags: [],
            importance: 3,
          };
          return {
            fact,
            score: typeof r.score === "number" ? clamp01(r.score) : 0.5,
            source: "mem0" as const,
          };
        });
      return { hits, backend: "mem0", scanned: hits.length };
    } catch {
      return null;
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
