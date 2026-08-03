/**
 * ChangeFilter — turns a stream of snapshots into a stream of
 * SIGNIFICANT changes. Significance is intentionally conservative:
 *
 *   - window switch    → emit when processName changes OR title's first
 *                        N alphanumeric tokens change. We ignore caret
 *                        movements that only change the title (e.g. file
 *                        name in VS Code already covered).
 *   - went idle        → user idle crossed the threshold this tick.
 *   - returned         → user idle drops back below 1/4 of the threshold
 *                        (clear "back at the desk" signal).
 *   - process spike    → working set jumped by > 30 % AND > 500 MB AND
 *                        the process is the same one we saw last tick.
 *
 * All thresholds live here so a future operator UI can tune them without
 * touching the loop coordinator.
 */
import type { ObservationChange, ObservationSnapshot } from "../types.js";

export type ChangeFilterOptions = {
  readonly idleThresholdMs: number;
};

const SPIKE_PCT = 0.3;
const SPIKE_MIN_DELTA_MB = 500;

export class ChangeFilter {
  private previous: ObservationSnapshot | null = null;

  constructor(private readonly opts: ChangeFilterOptions) {}

  next(snapshot: ObservationSnapshot): ObservationChange[] {
    const out: ObservationChange[] = [];
    const prev = this.previous;
    this.previous = snapshot;
    if (prev === null) {
      return out; // first sample is the baseline
    }

    // ── Window switch ──
    if (snapshot.foreground !== null) {
      if (
        prev.foreground === null ||
        prev.foreground.processName !== snapshot.foreground.processName ||
        normalizedTitle(prev.foreground.title) !== normalizedTitle(snapshot.foreground.title)
      ) {
        out.push({
          kind: "window.switched",
          from: prev.foreground,
          to: snapshot.foreground,
        });
      }
    }

    // ── Idle state ──
    const wasIdle = prev.userIdleMs >= this.opts.idleThresholdMs;
    const isIdle = snapshot.userIdleMs >= this.opts.idleThresholdMs;
    if (!wasIdle && isIdle) {
      out.push({ kind: "user.went.idle", idleForMs: snapshot.userIdleMs });
    } else if (wasIdle && snapshot.userIdleMs < this.opts.idleThresholdMs / 4) {
      out.push({ kind: "user.returned", awayForMs: prev.userIdleMs });
    }

    // ── Process RAM spike ──
    if (
      snapshot.topProcess !== null &&
      prev.topProcess !== null &&
      snapshot.topProcess.pid === prev.topProcess.pid
    ) {
      const delta = snapshot.topProcess.workingSetMB - prev.topProcess.workingSetMB;
      if (
        delta >= SPIKE_MIN_DELTA_MB &&
        delta / Math.max(1, prev.topProcess.workingSetMB) >= SPIKE_PCT
      ) {
        out.push({
          kind: "process.spiked",
          process: snapshot.topProcess,
          previousMB: prev.topProcess.workingSetMB,
        });
      }
    }

    return out;
  }
}

/** Normalise a title to ignore counters / caret position / unread badges.
 *  Strips leading/trailing non-alphanumeric noise and collapses whitespace. */
function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[\W_]+|[\W_]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}
