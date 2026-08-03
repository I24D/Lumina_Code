/**
 * Tool: lumina_presence_status
 *
 * Returns the current presence snapshot so the agent (or a human via the
 * chat) can ask "what are you doing right now?" and get a structured answer
 * without inference.
 *
 * Phase 1 surface is read-only. Phase 4 may add `lumina_presence_set` for
 * the agent to influence its own state, but we resist that — the engine
 * should always be downstream of real events, never the other way around.
 */
import { Type } from "typebox";
import { jsonResult } from "../../../../src/agents/tools/common.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import type { InitiativeDaemon } from "../initiative/initiative-daemon.js";
import type { PersonalityLayer } from "../personality/personality-layer.js";
import type { PresenceEngine } from "../services/presence-engine.js";

export function createPresenceStatusTool(
  engine: PresenceEngine,
  personality: PersonalityLayer,
  initiative: InitiativeDaemon,
): AnyAgentTool {
  return {
    name: "lumina_presence_status",
    label: "Lumina Presence Status",
    description:
      "Returns Lumina's current presence state (idle, listening, thinking, working, investigating, learning, waiting, completed) plus how long it has been in that state and a short list of the most recent state transitions. Read-only. Useful when the user asks what Lumina is doing right now, or for debugging the presence layer.",
    parameters: Type.Object({
      include_recent_transitions: Type.Optional(
        Type.Boolean({
          description: "Whether to include the recent transition ring buffer in the response. Default: true.",
        }),
      ),
      max_transitions: Type.Optional(
        Type.Integer({
          description: "Cap the number of recent transitions returned. Default 16, max 32 (the engine's ring-buffer size).",
          minimum: 1,
          maximum: 32,
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as {
        include_recent_transitions?: boolean;
        max_transitions?: number;
      };
      const snapshot = engine.snapshot();
      const includeTransitions = input.include_recent_transitions !== false;
      const cap = Math.max(1, Math.min(32, input.max_transitions ?? 16));
      return jsonResult({
        ok: true,
        state: snapshot.state,
        stateSinceISO: snapshot.stateSinceISO,
        stateAgeMs: snapshot.stateAgeMs,
        engineUptimeSec: snapshot.engineUptimeSec,
        personality: personality.snapshot(),
        initiative: initiative.snapshot(),
        recentTransitions: includeTransitions
          ? snapshot.recentTransitions.slice(0, cap)
          : [],
        schemaVersion: snapshot.schemaVersion,
      });
    },
  };
}
