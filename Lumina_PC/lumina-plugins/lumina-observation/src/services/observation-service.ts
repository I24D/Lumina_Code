/**
 * ObservationService — owns the polling loop.
 *
 * Lifecycle:
 *   start() → setInterval(pollIntervalMs) → sample → filter → narrate
 *   stop()  → clearInterval + drop in-flight sample
 *
 * Concurrency: we never overlap samples. If a sample is still running
 * when the timer ticks, we skip that tick. This is critical because
 * PowerShell startup latency varies on Windows.
 *
 * The service is fail-open: every observer that returns null is replaced
 * by a previous value or just skipped. The loop never throws.
 */
import { ChangeFilter } from "../filter/change-filter.js";
import { readForegroundWindow } from "../observers/window-observer.js";
import { readTopProcessByRam } from "../observers/process-observer.js";
import { readUserIdleMs } from "../observers/idle-observer.js";
import { NarratorEngine } from "../narrator/narrator-engine.js";
import type { Narration, ObservationChange, ObservationSnapshot } from "../types.js";

export type ObservationServiceOptions = {
  readonly pollIntervalMs: number;
  readonly idleThresholdMs: number;
  readonly narrationEnabled: boolean;
  readonly onChanges?: (
    changes: ReadonlyArray<ObservationChange>,
    snapshot: ObservationSnapshot,
  ) => void | Promise<void>;
};

export interface ObservationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export class ObservationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private lastSnapshot: ObservationSnapshot | null = null;
  private readonly filter: ChangeFilter;

  constructor(
    private readonly opts: ObservationServiceOptions,
    private readonly narrator: NarratorEngine,
    private readonly logger: ObservationLogger,
  ) {
    this.filter = new ChangeFilter({ idleThresholdMs: opts.idleThresholdMs });
  }

  start(): void {
    if (this.timer !== null) return;
    // Fire one sample immediately so the baseline lands before the first tick.
    void this.sampleOnce();
    const t = setInterval(() => {
      void this.sampleOnce();
    }, this.opts.pollIntervalMs);
    if (typeof t.unref === "function") t.unref();
    this.timer = t;
    this.logger.info("[lumina-observation] started", {
      pollMs: this.opts.pollIntervalMs,
      narration: this.opts.narrationEnabled,
    });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  lastObservation(): ObservationSnapshot | null {
    return this.lastSnapshot;
  }

  recentNarrations(limit: number): ReadonlyArray<Narration> {
    return this.narrator.recent(limit);
  }

  // ─── internals ────────────────────────────────────────────────

  private async sampleOnce(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [foreground, topProcess, idleMs] = await Promise.all([
        readForegroundWindow().catch(() => null),
        readTopProcessByRam().catch(() => null),
        readUserIdleMs().catch(() => 0),
      ]);
      const snapshot: ObservationSnapshot = {
        capturedAtISO: new Date().toISOString(),
        foreground,
        topProcess,
        userIdleMs: idleMs,
      };
      this.lastSnapshot = snapshot;
      const changes = this.filter.next(snapshot);
      if (changes.length === 0) return;
      this.logger.info("[lumina-observation] changes", {
        count: changes.length,
        kinds: changes.map((c) => c.kind),
      });
      if (this.opts.onChanges) {
        try {
          await this.opts.onChanges(changes, snapshot);
        } catch (err) {
          this.logger.warn("[lumina-observation] presence bridge failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (this.opts.narrationEnabled) {
        const narration = await this.narrator.narrate(changes);
        if (narration !== null) {
          this.logger.info("[lumina-observation] narration", {
            line: narration.line,
            causes: narration.causes,
          });
        }
      }
    } catch (err) {
      this.logger.warn("[lumina-observation] sample failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sampling = false;
    }
  }
}
