/**
 * Tool: lumina_observation_snapshot — returns the latest desktop snapshot.
 *
 * Phase 3 surface is read-only: the agent can ask "what is Dal doing right
 * now?" and get a current foreground window + top process + idle time
 * without invoking PowerShell itself.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ObservationService } from "../services/observation-service.js";

export function createObservationSnapshotTool(service: ObservationService): AnyAgentTool {
  return {
    name: "lumina_observation_snapshot",
    label: "Lumina Observation Snapshot",
    description:
      "Returns the most recent desktop observation captured by Lumina: foreground window (title + process), top RAM-consuming process, and user idle time in milliseconds. Useful when the user asks 'what am I doing right now?' or to ground a response in the current activity. Read-only and inexpensive.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = service.lastObservation();
      if (snapshot === null) {
        return jsonResult({
          ok: false,
          error: "no_snapshot_yet",
          message: "The observation loop has not produced a snapshot yet. Try again in a few seconds.",
        });
      }
      return jsonResult({
        ok: true,
        snapshot,
      });
    },
  };
}
