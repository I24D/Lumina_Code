/**
 * Tool: lumina_memory_remember — append a new fact to the long-term store.
 *
 * The agent calls this when the user says "remember that ..." or when it
 * autonomously decides a fact is worth keeping (per AGENTS.md). Facts are
 * append-only; updates are new facts, not edits.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { FactStore } from "../storage/fact-store.js";

export function createMemoryRememberTool(facts: FactStore): AnyAgentTool {
  return {
    name: "lumina_memory_remember",
    label: "Lumina Memory Remember",
    description:
      "Append a new fact to Lumina's long-term memory. Use when the user says 'recuerda que…' or when an important fact about the user, project, or workflow should be preserved across sessions. Facts are append-only; do not call this to 'edit' an old fact — add a new fact that supersedes it instead.",
    parameters: Type.Object({
      text: Type.String({
        description: "The fact in natural language, one sentence preferred. Max 2000 characters.",
        minLength: 1,
        maxLength: 2_000,
      }),
      source: Type.Optional(
        Type.String({
          description: "Optional attribution: 'user-stated', 'derived-from-chat', 'system-event'.",
          maxLength: 200,
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
          description: "Optional short tags to make recall easier. Examples: ['project:lumina', 'person:dal', 'pref:tone'].",
          maxItems: 16,
        }),
      ),
      importance: Type.Optional(
        Type.Integer({
          description: "Subjective importance 1..5. Defaults to 3. Higher gets a small boost in recall ranking.",
          minimum: 1,
          maximum: 5,
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as {
        text: string;
        source?: string;
        tags?: string[];
        importance?: number;
      };
      const stored = facts.add({
        text: input.text,
        source: input.source ?? null,
        tags: input.tags ?? [],
        importance: input.importance ?? 3,
      });
      return jsonResult({
        ok: true,
        fact: {
          id: stored.id,
          createdAtISO: stored.createdAtISO,
          text: stored.text,
          tags: stored.tags,
          importance: stored.importance,
          source: stored.source,
        },
      });
    },
  };
}
