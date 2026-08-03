/**
 * FactStore — append-only JSONL log of discrete facts.
 *
 * Why JSONL: a single bad line cannot corrupt the whole store; readers
 * skip malformed lines and continue. Crash-safe writes (one fact per
 * append). No locking needed for the access pattern (one writer, many
 * readers in-process).
 *
 * Phase 2 keeps everything in memory after the initial load. With
 * thousands of facts (the realistic upper bound for a personal user
 * for a few years) this is well under 10 MB and BM25 search stays fast.
 * If the store ever grows past ~50k facts, swap in a sqlite-backed
 * implementation behind the same interface.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { StoredFact } from "../types.js";

const DEFAULT_DIR = join(homedir(), ".lumina", "memory");
const FACT_FILE = "facts.jsonl";
const MAX_FACT_LEN = 2_000;

export type FactStoreOptions = {
  readonly factStoreDir?: string;
};

function makeId(): string {
  // Lexically sortable: timestamp ms in base36 + 6 random hex.
  return Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
}

export class FactStore {
  private readonly dir: string;
  private readonly file: string;
  private cache: StoredFact[] | null = null;

  constructor(opts: FactStoreOptions = {}) {
    this.dir = opts.factStoreDir ?? DEFAULT_DIR;
    this.file = join(this.dir, FACT_FILE);
  }

  /** Returns every fact currently in the store. Cached after first load. */
  list(): ReadonlyArray<StoredFact> {
    if (this.cache !== null) return this.cache;
    this.cache = this.loadFromDisk();
    return this.cache;
  }

  /** Append a new fact. Returns the stored fact (with id + timestamp filled). */
  add(input: {
    text: string;
    source?: string | null;
    tags?: ReadonlyArray<string>;
    importance?: number;
  }): StoredFact {
    const text = String(input.text ?? "").trim();
    if (!text) {
      throw new Error("FactStore.add: text is required");
    }
    if (text.length > MAX_FACT_LEN) {
      throw new Error(`FactStore.add: text exceeds ${MAX_FACT_LEN} characters`);
    }
    const fact: StoredFact = {
      id: makeId(),
      createdAtISO: new Date().toISOString(),
      text,
      source: input.source ?? null,
      tags: Array.from(new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))),
      importance: clamp(Number.isFinite(input.importance) ? Number(input.importance) : 3, 1, 5),
    };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, JSON.stringify(fact) + "\n", "utf8");
    if (this.cache !== null) this.cache.push(fact);
    return fact;
  }

  /** Drops the in-memory cache so the next list() re-reads from disk.
   *  Useful in tests; the engine does not need to call this. */
  invalidate(): void {
    this.cache = null;
  }

  filePath(): string {
    return this.file;
  }

  // ─── internals ────────────────────────────────────────────────

  private loadFromDisk(): StoredFact[] {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, "utf8");
    const out: StoredFact[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<StoredFact>;
        if (typeof parsed.id !== "string" || typeof parsed.text !== "string") continue;
        out.push({
          id: parsed.id,
          createdAtISO: typeof parsed.createdAtISO === "string" ? parsed.createdAtISO : new Date(0).toISOString(),
          text: parsed.text,
          source: typeof parsed.source === "string" ? parsed.source : null,
          tags: Array.isArray(parsed.tags)
            ? parsed.tags.filter((t): t is string => typeof t === "string")
            : [],
          importance: typeof parsed.importance === "number" ? clamp(parsed.importance, 1, 5) : 3,
        });
      } catch {
        // Skip malformed line silently. The whole store should never be
        // killed by one bad write.
      }
    }
    return out;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
