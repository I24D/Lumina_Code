/**
 * HeartbeatHook — bridges the existing `lumina-pc` heartbeat service into
 * the presence event bus. Phase 1 is intentionally thin: we receive a
 * heartbeat tick from somewhere (passed in by the entrypoint), translate
 * it into a `heartbeat.tick` event, and flag obvious anomalies as
 * `heartbeat.high-cpu`.
 *
 * NOTE: in Phase 1 we do not auto-wire to the lumina-pc service from inside
 * the plugin SDK because cross-plugin coupling needs more design. The
 * runtime entrypoint (`index.ts`) is responsible for feeding ticks to this
 * hook via `report(tick)`. That keeps the hook unit-testable.
 */
import type { PresenceEventBus } from "../event-bus.js";

export type HeartbeatTick = {
  readonly cpuPct: number;
  readonly ramPct: number;
};

export type HeartbeatHookConfig = {
  /** CPU percentage that triggers a high-cpu event. Default 90. */
  readonly highCpuThresholdPct: number;
};

export class HeartbeatHook {
  constructor(
    private readonly bus: PresenceEventBus,
    private readonly config: HeartbeatHookConfig = { highCpuThresholdPct: 90 },
  ) {}

  /** Call this from whoever owns the source of truth for heartbeat data. */
  report(tick: HeartbeatTick): void {
    this.bus.emit({
      kind: "heartbeat.tick",
      cpuPct: tick.cpuPct,
      ramPct: tick.ramPct,
    });
    if (tick.cpuPct >= this.config.highCpuThresholdPct) {
      this.bus.emit({
        kind: "heartbeat.high-cpu",
        cpuPct: tick.cpuPct,
      });
    }
  }
}
