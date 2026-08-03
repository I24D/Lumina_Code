/**
 * activity-log.ts — In-memory transparency log.
 *
 * Every meaningful action the agent takes is pushed here so the UI panel
 * can show: "right now I'm researching X, just clicked Y, last email
 * sent at 14:32 to Z". This is NOT a debug log — it's user-facing.
 *
 * Categories mirror the Transparency requirements:
 *   intent    — what Lumina plans to do
 *   tool      — which tool is being called
 *   app       — which application was opened
 *   agent     — which specialised agent is on duty
 *   file      — which file was touched
 *   email     — which email was analysed
 *   page      — which web page was visited
 *   command   — which shell command was run
 */

export type ActivityCategory =
  | "intent"
  | "tool"
  | "app"
  | "agent"
  | "file"
  | "email"
  | "page"
  | "command"
  | "risk"
  | "memory";

export type ActivityEntry = {
  readonly id: string;
  readonly atISO: string;
  readonly category: ActivityCategory;
  readonly summary: string;
  readonly detail?: string;
  /** Optional tier passthrough for risk-heavy entries. */
  readonly risk?: "SAFE" | "WARNING" | "HIGH_RISK" | "CRITICAL";
  readonly ref?: Readonly<Record<string, unknown>>;
};

export type ActivityListener = (e: ActivityEntry) => void;

export class ActivityLog {
  private readonly buf: ActivityEntry[] = [];
  private readonly listeners = new Set<ActivityListener>();
  private readonly cap = 512;

  push(input: Omit<ActivityEntry, "id" | "atISO">): ActivityEntry {
    const entry: ActivityEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      atISO: new Date().toISOString(),
      ...input,
    };
    this.buf.unshift(entry);
    if (this.buf.length > this.cap) this.buf.length = this.cap;
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  on(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(limit = 32): ReadonlyArray<ActivityEntry> {
    return this.buf.slice(0, Math.max(1, Math.min(this.cap, limit)));
  }

  byCategory(category: ActivityCategory, limit = 16): ReadonlyArray<ActivityEntry> {
    return this.buf.filter((e) => e.category === category).slice(0, limit);
  }
}
