/**
 * kill-switch.ts — Global emergency stop for all autonomous PC control.
 *
 * §9 of the Cognitive Bridge spec: a dedicated global key that cuts ALL
 * agent-driven movement at once. This module is the in-process authority:
 *
 *   - The loop engine checks `killSwitch.isEngaged()` at the top of every
 *     iteration and aborts the run if engaged.
 *   - The action dispatcher refuses to dispatch ANY action while engaged,
 *     so no click/type/scroll reaches the Bridge even mid-plan.
 *   - A Python sidecar (`kill_switch.py`, global hotkey via pynput) flips it
 *     from a real keypress the user can hit at any time — even while an agent
 *     is mid-action — via `kill-switch-process.ts`.
 *
 * Engaging is sticky: once tripped, the operator stays frozen until something
 * explicitly calls `reset()` (the `lumina_kill_switch` tool, re-arm). This is
 * deliberate — a panic stop should not silently un-trip.
 */

export type KillSwitchState = {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly engagedAtISO: string | null;
  readonly resetAtISO: string | null;
  readonly engageCount: number;
};

export type KillSwitchListener = (reason: string) => void;

class KillSwitch {
  private engaged = false;
  private reason: string | null = null;
  private engagedAtISO: string | null = null;
  private resetAtISO: string | null = null;
  private engageCount = 0;
  private readonly listeners = new Set<KillSwitchListener>();

  isEngaged(): boolean {
    return this.engaged;
  }

  getState(): KillSwitchState {
    return {
      engaged: this.engaged,
      reason: this.reason,
      engagedAtISO: this.engagedAtISO,
      resetAtISO: this.resetAtISO,
      engageCount: this.engageCount,
    };
  }

  /** Trip the kill switch. Idempotent while already engaged. */
  engage(reason = "manual"): KillSwitchState {
    if (!this.engaged) {
      this.engaged = true;
      this.reason = reason;
      this.engagedAtISO = new Date().toISOString();
      this.engageCount += 1;
      for (const listener of this.listeners) {
        try {
          listener(reason);
        } catch {
          /* a listener must never block the panic path */
        }
      }
    }
    return this.getState();
  }

  /** Re-arm: clear the frozen state so the operator can run again. */
  reset(): KillSwitchState {
    this.engaged = false;
    this.reason = null;
    this.resetAtISO = new Date().toISOString();
    return this.getState();
  }

  /**
   * Subscribe to engage events (e.g. so the loop engine can abort every active
   * run immediately, not only at the next iteration boundary). Returns an
   * unsubscribe function.
   */
  onEngage(listener: KillSwitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Process-wide singleton. Import this everywhere; never construct another. */
export const killSwitch = new KillSwitch();

/**
 * Guard for the dispatch path. Throws when engaged so any in-flight action
 * chain unwinds instead of touching the desktop.
 */
export function assertKillSwitchClear(): void {
  if (killSwitch.isEngaged()) {
    const state = killSwitch.getState();
    throw new Error(
      `kill_switch_engaged: operator frozen (${state.reason ?? "manual"} at ${state.engagedAtISO ?? "?"}). Re-arm with lumina_kill_switch reset.`,
    );
  }
}
