/**
 * Presence Engine — owns the current presence state and drives transitions.
 *
 * Phase 1 surface (passive):
 *   - Subscribes to events on the bus
 *   - Runs the pure FSM in `presence-state.ts::nextState`
 *   - Emits a `presence.idle-timeout` to itself after `idleTimeoutMs` of no
 *     state-changing events
 *   - Keeps a small ring buffer of recent transitions for debugging
 *   - Exposes a snapshot for the status tool
 *
 * Phase 1 NON-surface (deferred to later phases):
 *   - Generating voice / narration (Phase 3)
 *   - Initiating conversation (Phase 4)
 *   - Persisting transitions to disk (only useful once memory layer lands)
 */
import { INITIAL_PRESENCE_STATE, nextState } from "../presence-state.js";
import type { PresenceEventBus } from "../event-bus.js";
import type { PresenceEvent, PresenceSnapshot, PresenceState, PresenceTransition } from "../types.js";

export type PresenceEngineConfig = {
  readonly enabled: boolean;
  readonly stateTransitionLogLevel: "off" | "summary" | "verbose";
  readonly idleTimeoutMs: number;
};

/**
 * Minimal logger shape we accept. Compatible with both `console` and the
 * structured logger the OpenClaw runtime passes to plugins.
 */
export interface PresenceLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** How many transitions we keep in the ring buffer. */
const RECENT_TRANSITION_BUFFER = 32;

export class PresenceEngine {
  private currentState: PresenceState = INITIAL_PRESENCE_STATE;
  private stateSinceMs: number = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly recentTransitions: PresenceTransition[] = [];
  private readonly bootMs: number = Date.now();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly transitionListeners = new Set<(transition: PresenceTransition) => void>();

  constructor(
    private readonly bus: PresenceEventBus,
    private readonly config: PresenceEngineConfig,
    private readonly logger: PresenceLogger,
  ) {}

  /** Wire up subscriptions and start the idle timer. Idempotent. */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info("[lumina-presence] disabled by config; engine not started");
      return;
    }
    if (this.unsubscribers.length > 0) {
      // Already started.
      return;
    }

    // Subscribe to every event kind. We don't enumerate them individually
    // because the FSM is the single decision point; the bus would just
    // forward everything anyway. Using individual subscriptions keeps the
    // types tight per kind, but for the engine we want one funnel.
    const allKinds = [
      "agent.turn.start",
      "agent.turn.end",
      "agent.tool.invoke",
      "agent.tool.complete",
      "agent.consult.requested",
      "heartbeat.tick",
      "heartbeat.high-cpu",
      "voice.session.start",
      "voice.session.end",
      "voice.user.speech.start",
      "voice.user.speech.end",
      "voice.assistant.speech.start",
      "voice.assistant.speech.end",
      "observation.window.changed",
      "observation.user.idle",
      "observation.user.returned",
      "observation.process.spiked",
      "presence.idle-timeout",
    ] as const;

    for (const kind of allKinds) {
      const off = this.bus.on(kind, (event) => this.handle(event as PresenceEvent));
      this.unsubscribers.push(off);
    }

    this.armIdleTimer();
    this.logger.info("[lumina-presence] engine started", {
      initialState: this.currentState,
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
  }

  /** Tear down subscriptions and clear timers. Safe to call multiple times. */
  stop(): void {
    for (const off of this.unsubscribers) {
      off();
    }
    this.unsubscribers.length = 0;
    this.clearIdleTimer();
  }

  /** Public snapshot used by the `lumina_presence_status` tool. */
  snapshot(): PresenceSnapshot {
    const now = Date.now();
    return {
      state: this.currentState,
      stateSinceISO: new Date(this.stateSinceMs).toISOString(),
      stateAgeMs: now - this.stateSinceMs,
      // Reversed so the most recent transition is first.
      recentTransitions: [...this.recentTransitions].reverse(),
      engineUptimeSec: Math.round((now - this.bootMs) / 1000),
      schemaVersion: 1,
    };
  }

  onTransition(listener: (transition: PresenceTransition) => void): () => void {
    this.transitionListeners.add(listener);
    return () => this.transitionListeners.delete(listener);
  }

  // ─── internals ────────────────────────────────────────────────

  private handle(event: PresenceEvent): void {
    const target = nextState(this.currentState, event);

    if (target === this.currentState) {
      // No transition. Still re-arm the idle timer for any event that means
      // the system is alive, so we don't fall asleep mid-activity.
      this.armIdleTimer();
      return;
    }

    const transition: PresenceTransition = {
      fromState: this.currentState,
      toState: target,
      cause: event.kind,
      at: new Date().toISOString(),
    };

    this.currentState = target;
    this.stateSinceMs = Date.now();

    // Ring buffer: drop the oldest if we exceed the cap.
    this.recentTransitions.push(transition);
    if (this.recentTransitions.length > RECENT_TRANSITION_BUFFER) {
      this.recentTransitions.shift();
    }

    this.logTransition(transition, event);
    for (const listener of this.transitionListeners) {
      try {
        listener(transition);
      } catch (err) {
        this.logger.warn("[lumina-presence] transition listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.armIdleTimer();
  }

  private logTransition(transition: PresenceTransition, event: PresenceEvent): void {
    if (this.config.stateTransitionLogLevel === "off") return;
    const base = {
      from: transition.fromState,
      to: transition.toState,
      cause: transition.cause,
    };
    if (this.config.stateTransitionLogLevel === "verbose") {
      this.logger.info("[lumina-presence] transition", { ...base, event });
    } else {
      this.logger.info("[lumina-presence] transition", base);
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.config.idleTimeoutMs;
    if (!Number.isFinite(ms) || ms <= 0) return;
    const t = setTimeout(() => {
      // The timer's only job is to publish an internal event so the FSM
      // gets a fair shot at transitioning. We don't mutate state directly.
      this.bus.emit({ kind: "presence.idle-timeout" });
    }, ms);
    // Critical: don't keep the runtime alive just because of this timer.
    if (typeof t.unref === "function") t.unref();
    this.idleTimer = t;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
