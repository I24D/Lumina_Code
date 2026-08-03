/**
 * action-log.ts — Append-only semantic log of every tool execution.
 *
 * Schema (Spec 3): { ts, action, target, result, source }
 *   - ts       ISO timestamp (millisecond precision)
 *   - action   short verb/tool id ("workflow.run", "ui.click", "launch.chrome")
 *   - target   what was acted on ("recipe:modo_trabajo", "btn:Guardar", "chrome")
 *   - result   "ok" | "skipped" | "error" | "warn" + optional detail
 *   - source   who emitted ("workflow-engine", "agent", "bridge", "wake")
 *
 * Persisted as JSONL at <memoryDir>/action-log.jsonl. recall() returns
 * the most recent entries filtered by time window + action substring.
 * This is the "Working Memory" the LLM consults at the top of every voice
 * turn ("¿qué estaba haciendo hace 5 minutos?") WITHOUT having to read
 * the entire episodic log.
 */
import path from "node:path";
import { appendJsonl, ensureDir, readJsonlSync } from "./store.js";

export type ActionLogEntry = {
  readonly ts: string;
  readonly action: string;
  readonly target: string;
  readonly result: "ok" | "skipped" | "error" | "warn";
  readonly detail?: string;
  readonly source: string;
  readonly extra?: Readonly<Record<string, unknown>>;
};

export type RecallQuery = {
  readonly windowSeconds?: number;
  readonly action?: string;
  readonly source?: string;
  readonly limit?: number;
};

export class ActionLogStore {
  private readonly filePath: string;
  /** In-memory ring buffer of the most recent entries, capped to avoid
   *  re-reading the JSONL file on every recall. */
  private buffer: ActionLogEntry[] = [];
  private readonly bufferCap = 2000;

  constructor(dir: string) {
    this.filePath = path.join(dir, "action-log.jsonl");
    ensureDir(dir);
    this.buffer = readJsonlSync<ActionLogEntry>(this.filePath).slice(-this.bufferCap);
  }

  append(entry: Omit<ActionLogEntry, "ts"> & { ts?: string }): ActionLogEntry {
    const stamped: ActionLogEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      action: entry.action,
      target: entry.target,
      result: entry.result,
      detail: entry.detail,
      source: entry.source,
      extra: entry.extra,
    };
    appendJsonl(this.filePath, stamped);
    this.buffer.push(stamped);
    if (this.buffer.length > this.bufferCap) {
      this.buffer.splice(0, this.buffer.length - this.bufferCap);
    }
    return stamped;
  }

  recall(query: RecallQuery = {}): ActionLogEntry[] {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const window = query.windowSeconds && query.windowSeconds > 0 ? query.windowSeconds : null;
    const sinceMs = window ? Date.now() - window * 1000 : null;
    const actionN = query.action?.trim().toLowerCase() ?? "";
    const sourceN = query.source?.trim().toLowerCase() ?? "";

    const filtered: ActionLogEntry[] = [];
    for (let i = this.buffer.length - 1; i >= 0 && filtered.length < limit; i--) {
      const entry = this.buffer[i]!;
      if (sinceMs !== null) {
        const t = Date.parse(entry.ts);
        if (Number.isFinite(t) && t < sinceMs) break;
      }
      if (actionN && !entry.action.toLowerCase().includes(actionN)) continue;
      if (sourceN && entry.source.toLowerCase() !== sourceN) continue;
      filtered.push(entry);
    }
    return filtered;
  }

  size(): number {
    return this.buffer.length;
  }

  filePathForDebug(): string {
    return this.filePath;
  }
}
