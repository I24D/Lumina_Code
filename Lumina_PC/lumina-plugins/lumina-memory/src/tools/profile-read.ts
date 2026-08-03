/**
 * Tool: lumina_memory_profile_read — return the user profile document.
 *
 * The agent should call this near the start of a session to know who it
 * is talking to (preferences, role, active projects, pinned facts). It is
 * a cheap call (one JSON read) and idempotent.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ProfileStore } from "../storage/profile-store.js";

export function createProfileReadTool(profile: ProfileStore): AnyAgentTool {
  return {
    name: "lumina_memory_profile_read",
    label: "Lumina Memory Profile Read",
    description:
      "Read Lumina's stored user profile: display name, role, language, preferences map, active projects, pinned facts, and timestamps. Useful at session start to know who the user is and what they care about. Read-only.",
    parameters: Type.Object({}),
    async execute() {
      const p = profile.read();
      return jsonResult({
        ok: true,
        filePath: profile.filePath(),
        profile: p,
      });
    },
  };
}
