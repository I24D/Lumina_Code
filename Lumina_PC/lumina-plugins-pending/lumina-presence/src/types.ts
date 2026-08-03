/**
 * Lumina Presence — shared types.
 *
 * The presence engine is a passive observer in Phase 1. It listens to events
 * from the OpenClaw runtime and from local services, infers a presence
 * state, and exposes it to the agent. It does NOT execute actions, narrate,
 * or initiate conversations in this phase — those land in Phases 3 and 4.
 *
 * Design rules (Phase 1):
 *   - Side-effect free state machine. All transitions are pure functions of
 *     (previousState, event).
 *   - Zero polling. Transitions happen ONLY when an event arrives.
 *   - Idle = 0% CPU (only an unref'd timer for idle timeout).
 *   - Strict TypeScript, no `any`, no implicit nulls.
 */

/** The eight presence states requested in the brief. Order is intentional:
 *  later states roughly imply "more engaged". */
export const PRESENCE_STATES = [
  "idle",
  "listening",
  "thinking",
  "working",
  "investigating",
  "learning",
  "waiting",
  "completed",
] as const;

export type PresenceState = (typeof PRESENCE_STATES)[number];

/** A transition is an (old, new) pair plus the event that caused it.
 *  Persisted to the in-memory ring buffer for debugging and audit. */
export type PresenceTransition = {
  readonly fromState: PresenceState;
  readonly toState: PresenceState;
  readonly cause: PresenceEvent["kind"];
  readonly at: string; // ISO timestamp
};

/** Discriminated union of every event the presence engine consumes.
 *  Adding a new event source = adding a member here, then a handler in
 *  `presence-state.ts::nextState`. */
export type PresenceEvent =
  // From the OpenClaw agent runtime
  | { kind: "agent.turn.start"; sessionKey: string }
  | { kind: "agent.turn.end"; sessionKey: string; ok: boolean }
  | { kind: "agent.tool.invoke"; toolName: string; sessionKey: string }
  | { kind: "agent.tool.complete"; toolName: string; sessionKey: string; ok: boolean }
  | { kind: "agent.consult.requested"; sessionKey: string }
  // From the heartbeat service
  | { kind: "heartbeat.tick"; cpuPct: number; ramPct: number }
  | { kind: "heartbeat.high-cpu"; cpuPct: number }
  // From the realtime voice (Talk) layer
  | { kind: "voice.session.start" }
  | { kind: "voice.session.end" }
  | { kind: "voice.user.speech.start" }
  | { kind: "voice.user.speech.end" }
  | { kind: "voice.assistant.speech.start" }
  | { kind: "voice.assistant.speech.end" }
  // From observation services (Phase 3 stubs — declared now for type stability)
  | { kind: "observation.window.changed"; title: string; processName: string }
  | { kind: "observation.user.idle"; lastActiveMs: number }
  | { kind: "observation.user.returned"; awayForMs: number }
  | {
      kind: "observation.process.spiked";
      processName: string;
      workingSetMB: number;
      previousMB: number;
    }
  // Internal — triggered by the idle timer
  | { kind: "presence.idle-timeout" };

/** Snapshot returned by the `lumina_presence_status` tool. */
export type PresenceSnapshot = {
  readonly state: PresenceState;
  readonly stateSinceISO: string;
  readonly stateAgeMs: number;
  readonly recentTransitions: ReadonlyArray<PresenceTransition>;
  readonly engineUptimeSec: number;
  readonly schemaVersion: 1;
};

/** Mapped type that lets `EventBus.on` enforce the right payload shape per
 *  event kind. Without this, every handler would receive the broad union and
 *  need narrowing at every call site. */
export type PresenceEventOf<K extends PresenceEvent["kind"]> = Extract<
  PresenceEvent,
  { kind: K }
>;
