/**
 * Tool: lumina_memory_profile_update — atomically merge a patch into the profile.
 *
 * Each call merges the provided slots over the existing profile. Atomic
 * write (tmp + rename) so a crash mid-update never leaves a partial
 * document. The `preferences` map is merged key-by-key (not replaced);
 * arrays (`projects`, `pinnedFacts`) ARE replaced as wholes — the agent
 * is expected to read first, modify, then write back.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { ProfileStore } from "../storage/profile-store.js";
import type { UserProfile, UserProject } from "../types.js";

type MutableProfilePatch = {
  -readonly [K in keyof UserProfile]?: UserProfile[K];
};

export function createProfileUpdateTool(profile: ProfileStore): AnyAgentTool {
  return {
    name: "lumina_memory_profile_update",
    label: "Lumina Memory Profile Update",
    description:
      "Update Lumina's user profile. Each named slot is optional; only the ones provided are changed. 'preferences' is MERGED key-by-key over existing keys; 'projects' and 'pinnedFacts' are REPLACED — read the current profile first if you only want to add or modify a single entry. The schema version is managed automatically.",
    parameters: Type.Object({
      displayName: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
      role: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])),
      language: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
      preferences: Type.Optional(
        Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ maxLength: 400 }), {
          description: "Key→value preferences merged into the existing map. Empty string deletes the key.",
        }),
      ),
      projects: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.String({ maxLength: 1_000 }),
            active: Type.Boolean(),
          }),
          { maxItems: 32, description: "REPLACES the existing projects array." },
        ),
      ),
      pinnedFacts: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 400 }), {
          maxItems: 32,
          description: "REPLACES the existing pinned-facts array.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as {
        displayName?: string | null;
        role?: string | null;
        language?: string | null;
        preferences?: Record<string, string>;
        projects?: UserProject[];
        pinnedFacts?: string[];
      };
      // Special semantics: an empty-string value in preferences removes the key.
      const patch: MutableProfilePatch = {};
      if (input.displayName !== undefined) patch.displayName = input.displayName;
      if (input.role !== undefined) patch.role = input.role;
      if (input.language !== undefined) patch.language = input.language;
      if (input.projects !== undefined) patch.projects = input.projects;
      if (input.pinnedFacts !== undefined) patch.pinnedFacts = input.pinnedFacts;
      if (input.preferences !== undefined) {
        // Read current preferences and apply key-by-key with delete semantics.
        const current = { ...profile.read().preferences };
        for (const [k, v] of Object.entries(input.preferences)) {
          if (v === "") delete current[k];
          else current[k] = v;
        }
        patch.preferences = current;
      }
      const next = profile.update(patch);
      return jsonResult({ ok: true, profile: next });
    },
  };
}
