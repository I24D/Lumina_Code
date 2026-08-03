/**
 * Presence state machine — pure logic, no side effects.
 *
 * `nextState(currentState, event)` returns the state Lumina SHOULD be in
 * after the event. Edge cases (e.g. ignoring tool events while the user is
 * speaking) are handled here so the engine remains a thin wrapper that just
 * drives the FSM.
 *
 * Test surface (Phase 1.1 — landed with tests in the next iteration):
 *   - Every (state, event) pair is deterministic.
 *   - No state can transition to itself unless the event is meaningful
 *     (e.g. consecutive tool invocations keep us in "working" without
 *     spamming transitions).
 */
import type { PresenceEvent, PresenceState } from "./types.js";

/** Default starting state on engine boot. */
export const INITIAL_PRESENCE_STATE: PresenceState = "idle";

/**
 * Resolve the next presence state given the current state and an incoming
 * event. Returns the SAME state if the event is not relevant — callers
 * compare before/after to decide whether to emit a transition.
 */
export function nextState(current: PresenceState, event: PresenceEvent): PresenceState {
  switch (event.kind) {
    // ── Voice events (Stark Talk) ────────────────────────────────
    case "voice.session.start":
      // Entering voice mode means we're at least "listening" by default —
      // the next voice event will narrow it to listening/thinking/speaking.
      return "listening";

    case "voice.session.end":
      // Coming out of voice: revert to a neutral state. Idle is correct
      // because text chat events will quickly bump us to working/thinking.
      return "idle";

    case "voice.user.speech.start":
      return "listening";

    case "voice.user.speech.end":
      // User stopped talking; we're processing what they said.
      return "thinking";

    case "voice.assistant.speech.start":
      // Lumina is speaking — this is its own state distinct from "working"
      // because the avatar / orb behaves differently.
      return "working"; // Phase 1 collapses speaking into working; Phase 4 splits them.

    case "voice.assistant.speech.end":
      // After speaking, we're typically waiting for the user's next input.
      return "waiting";

    // ── Agent runtime events ─────────────────────────────────────
    case "agent.turn.start":
      // A new turn started. If we were idle/waiting/completed, we're now
      // thinking. If we were already working/investigating, stay there.
      if (current === "idle" || current === "waiting" || current === "completed") {
        return "thinking";
      }
      return current;

    case "agent.turn.end":
      // Turn finished. Result quality reflects what we land on.
      return event.ok ? "completed" : "waiting";

    case "agent.consult.requested":
      // Voice asked the main agent for help. We're investigating.
      return "investigating";

    case "agent.tool.invoke":
      // A tool was called. Different tool families hint at different states.
      if (event.toolName.startsWith("security_") || event.toolName.includes("audit")) {
        return "investigating";
      }
      if (
        event.toolName.includes("memory") ||
        event.toolName.includes("learn") ||
        event.toolName.includes("recall")
      ) {
        return "learning";
      }
      return "working";

    case "agent.tool.complete":
      // Don't transition on tool completion; the turn-end event will do it.
      return current;

    // ── Heartbeat events ─────────────────────────────────────────
    case "heartbeat.high-cpu":
      // High CPU during idle could mean a runaway process. Stay aware —
      // don't change state but the engine logs it for the next phase.
      return current;

    case "heartbeat.tick":
      // Periodic heartbeat; not a state-changing event.
      return current;

    // ── Observation events (stubs for Phase 3 — declared for type stability) ─
    case "observation.window.changed":
      return current;

    case "observation.user.idle":
      // The OS reports the user has been away. Don't go idle if we're working —
      // Lumina may be in the middle of a long task. Only transition from
      // states that mean we're waiting on the user.
      if (current === "listening" || current === "waiting" || current === "completed") {
        return "idle";
      }
      return current;

    case "observation.user.returned":
      return current === "idle" ? "waiting" : current;

    case "observation.process.spiked":
      return "investigating";

    // ── Internal events ─────────────────────────────────────────
    case "presence.idle-timeout":
      // The engine's own timer fired. Only honor it if we're in a "wait"-y
      // state. Active states (working/thinking/investigating) are ignored.
      if (current === "waiting" || current === "completed" || current === "listening") {
        return "idle";
      }
      return current;
  }
}
