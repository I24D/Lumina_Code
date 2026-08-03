/**
 * Lumina Observation — shared types.
 *
 * One snapshot per polling tick. The snapshot is the input to the change
 * filter; the filter emits significant CHANGES; the narrator translates
 * changes to human-readable lines.
 *
 * Privacy rule: observation payloads never include file contents,
 * clipboard contents, or screenshot pixels. Window TITLES (which a sloppy
 * user may have leaking passwords) are length-capped and tokenised before
 * being sent to the narrator LLM.
 */

export type ObservationSnapshot = {
  readonly capturedAtISO: string;
  readonly foreground: ForegroundWindow | null;
  readonly topProcess: ProcessSummary | null;
  readonly userIdleMs: number;
};

export type ForegroundWindow = {
  /** Truncated to 240 chars to limit prompt cost and accidental leaks. */
  readonly title: string;
  readonly processName: string;
  readonly processId: number;
};

export type ProcessSummary = {
  readonly name: string;
  readonly pid: number;
  readonly workingSetMB: number;
  readonly cpuSec: number;
};

/**
 * A significant CHANGE detected between two snapshots. Multiple changes
 * can be emitted from a single sample (e.g. user came back AND window
 * switched in the same tick).
 */
export type ObservationChange =
  | { kind: "window.switched"; from: ForegroundWindow | null; to: ForegroundWindow }
  | { kind: "user.went.idle"; idleForMs: number }
  | { kind: "user.returned"; awayForMs: number }
  | { kind: "process.spiked"; process: ProcessSummary; previousMB: number };

export type Narration = {
  readonly atISO: string;
  /** The triggering change(s) — one Narration per LLM call, possibly
   *  covering multiple changes that arrived in the same tick. */
  readonly causes: ReadonlyArray<ObservationChange["kind"]>;
  /** The single sentence Lumina would say out loud, in Spanish, ≤ 80 chars
   *  preferred. Phase 4 will gate whether to actually speak it. */
  readonly line: string;
};
