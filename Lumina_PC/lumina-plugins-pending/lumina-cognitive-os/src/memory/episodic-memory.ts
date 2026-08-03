/**
 * episodic-memory.ts — Time-stamped events of "what the user did".
 *
 * Each entry has:
 *   - id, atISO, kind (window/file/voice/tool/action), summary, tags, ref
 *
 * Storage is JSONL so reads are linear but appends are atomic.
 * Recall returns the last N entries matching by tag, kind, or substring.
 */
import path from "node:path";
import { appendJsonl, newId, readJsonlSync } from "./store.js";

export type EpisodeKind =
  | "window"
  | "file"
  | "voice"
  | "tool"
  | "action"
  | "intent"
  | "system"
  | "note";

export type Episode = {
  readonly id: string;
  readonly atISO: string;
  readonly kind: EpisodeKind;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  /** Optional structured payload — e.g. {windowTitle, processName} for kind="window". */
  readonly ref?: Readonly<Record<string, unknown>>;
};

export type RecallQuery = {
  readonly kinds?: ReadonlyArray<EpisodeKind>;
  readonly tags?: ReadonlyArray<string>;
  readonly substring?: string;
  readonly sinceISO?: string;
  readonly limit?: number;
};

export class EpisodicMemoryStore {
  private readonly filePath: string;
  private buf: Episode[] = [];
  private readonly cacheLimit = 5_000;

  constructor(dir: string) {
    this.filePath = path.join(dir, "episodic.jsonl");
    this.buf = readJsonlSync<Episode>(this.filePath);
    if (this.buf.length > this.cacheLimit) {
      this.buf = this.buf.slice(this.buf.length - this.cacheLimit);
    }
  }

  remember(input: Omit<Episode, "id" | "atISO">): Episode {
    const ep: Episode = {
      id: newId(),
      atISO: new Date().toISOString(),
      ...input,
      tags: input.tags ?? [],
    };
    appendJsonl(this.filePath, ep);
    this.buf.push(ep);
    if (this.buf.length > this.cacheLimit) this.buf.shift();
    return ep;
  }

  recall(query: RecallQuery): Episode[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 50));
    const since = query.sinceISO ? Date.parse(query.sinceISO) : 0;
    const substr = query.substring?.toLowerCase() ?? "";
    const kinds = query.kinds && query.kinds.length ? new Set(query.kinds) : null;
    const tags = query.tags && query.tags.length ? new Set(query.tags) : null;
    const out: Episode[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const ep = this.buf[i];
      if (!ep) continue;
      if (kinds && !kinds.has(ep.kind)) continue;
      if (since > 0 && Date.parse(ep.atISO) < since) continue;
      if (tags) {
        let hit = false;
        for (const t of ep.tags) {
          if (tags.has(t)) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
      }
      if (substr && !ep.summary.toLowerCase().includes(substr)) continue;
      out.push(ep);
    }
    return out;
  }

  /** Snapshot the last N entries regardless of filter — used by the panel. */
  tail(limit = 20): Episode[] {
    return this.buf.slice(-limit).reverse();
  }
}
