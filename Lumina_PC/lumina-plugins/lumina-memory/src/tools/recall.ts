/**
 * Tool: lumina_memory_recall — semantic-ish recall over the fact store.
 *
 * Returns the top-N most relevant facts for a natural-language query.
 * Backend is BM25 by default; mem0 if configured.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import type { RecallEngine } from "../recall/recall-engine.js";

export function createMemoryRecallTool(engine: RecallEngine, defaultLimit: number): AnyAgentTool {
  return {
    name: "lumina_memory_recall",
    label: "Lumina Memory Recall",
    description:
      "Search Lumina's long-term memory for facts relevant to a query. Returns the top N facts ranked by relevance, with score and source. Uses BM25 over the local fact store by default; uses the configured mem0 service when available. NEVER hallucinates facts not actually in the store.",
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language query, e.g. 'preferencias de tono de Dal' or 'estado del proyecto Lumina Code'.",
        minLength: 1,
        maxLength: 2_000,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: `How many facts to return at most. Defaults to ${defaultLimit}.`,
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const input = params as { query: string; limit?: number };
      const result = await engine.recall(input.query, input.limit);
      if (result === null) {
        return jsonResult({
          ok: false,
          error: "recall_backend_unavailable",
          message:
            "Recall backend (mem0) is configured but did not respond. Falling back is intentionally disabled to avoid silently downgrading semantic recall to keyword search.",
        });
      }
      return jsonResult({
        ok: true,
        backend: result.backend,
        scanned: result.scanned,
        hits: result.hits.map((h) => ({
          score: h.score,
          source: h.source,
          fact: {
            id: h.fact.id,
            text: h.fact.text,
            createdAtISO: h.fact.createdAtISO,
            tags: h.fact.tags,
            importance: h.fact.importance,
            source: h.fact.source,
          },
        })),
      });
    },
  };
}
