/**
 * memory-tools.ts — Agent-facing tools for Working and Episodic memory.
 *
 *   lumina_working_memory_get
 *   lumina_working_memory_set
 *   lumina_episodic_remember
 *   lumina_episodic_recall
 *
 * Voice flow: "Lumina, recuerda que estoy trabajando en el dashboard de ventas"
 *   → working_memory_set({ currentProject:{ name:"dashboard de ventas", path:"" }, currentIntent:"build" })
 *   → episodic_remember({ kind:"intent", summary:"comencé el dashboard de ventas", tags:["work"] })
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool, ToolInputError } from "../shared/tool-result.js";
import type { EpisodicMemoryStore, EpisodeKind } from "./episodic-memory.js";
import type { WorkingMemoryStore } from "./working-memory.js";

const KINDS = ["window", "file", "voice", "tool", "action", "intent", "system", "note"] as const;

export function createWorkingMemoryGetTool(store: WorkingMemoryStore): AnyAgentTool {
  return {
    name: "lumina_working_memory_get",
    label: "Lumina Working Memory — Read",
    description:
      "Returns Lumina's working memory: current project, active window, active file, current intent, " +
      "pinned context lines. Call this at the start of every voice turn to ground the answer in what " +
      "the user is actually doing.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({ ok: true, working: store.get() });
    },
  };
}

export function createWorkingMemorySetTool(store: WorkingMemoryStore): AnyAgentTool {
  return {
    name: "lumina_working_memory_set",
    label: "Lumina Working Memory — Write",
    description:
      "Updates Lumina's working memory. Pass any subset of fields. Use this when the user changes context " +
      "('estoy ahora en X', 'cambia de proyecto a Y'). Use pinnedContext for the ≤5 lines that should be " +
      "injected into every future voice turn.",
    parameters: Type.Object({
      currentProject: Type.Optional(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          path: Type.String({ maxLength: 1024 }),
        }),
      ),
      activeWindow: Type.Optional(
        Type.Object({
          processName: Type.String({ maxLength: 120 }),
          title: Type.String({ maxLength: 480 }),
        }),
      ),
      activeFile: Type.Optional(Type.String({ maxLength: 2048 })),
      currentIntent: Type.Optional(Type.String({ maxLength: 240 })),
      pinnedContext: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 5 }),
      ),
    }),
    async execute(_id, params) {
      const next = store.set(params);
      return jsonResult({ ok: true, working: next });
    },
  };
}

export function createEpisodicRememberTool(store: EpisodicMemoryStore): AnyAgentTool {
  return {
    name: "lumina_episodic_remember",
    label: "Lumina Episodic — Remember",
    description:
      "Append a timestamped event to episodic memory: 'opened VS Code at 14:32', 'finished the sales report', " +
      "'switched to focus mode'. Use frequently — episodic memory is what lets the user ask 'qué hice el lunes pasado a las 3?'",
    parameters: Type.Object({
      kind: Type.Union(
        KINDS.map((k) => Type.Literal(k)),
        { description: "Episode kind." },
      ),
      summary: Type.String({ minLength: 1, maxLength: 480 }),
      tags: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 12 }),
      ),
      ref: Type.Optional(Type.Unknown({ description: "Optional structured payload." })),
    }),
    async execute(_id, params) {
      const summary = params.summary?.trim();
      if (!summary) throw new ToolInputError("summary is required");
      const ep = store.remember({
        kind: params.kind as EpisodeKind,
        summary,
        tags: params.tags ?? [],
        ref: params.ref as Record<string, unknown> | undefined,
      });
      return jsonResult({ ok: true, episode: ep });
    },
  };
}

export function createEpisodicRecallTool(store: EpisodicMemoryStore): AnyAgentTool {
  return {
    name: "lumina_episodic_recall",
    label: "Lumina Episodic — Recall",
    description:
      "Retrieve recent episodic memories matching kinds/tags/substring/sinceISO. Use this when the user asks " +
      "'qué hice X', 'cuándo abrí Y', 'muéstrame mi sesión de la mañana'.",
    parameters: Type.Object({
      kinds: Type.Optional(
        Type.Array(Type.Union(KINDS.map((k) => Type.Literal(k))), { maxItems: 8 }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 12 }),
      ),
      substring: Type.Optional(Type.String({ maxLength: 200 })),
      sinceISO: Type.Optional(Type.String({ maxLength: 64 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
    }),
    async execute(_id, params) {
      const eps = store.recall({
        kinds: params.kinds as EpisodeKind[] | undefined,
        tags: params.tags,
        substring: params.substring,
        sinceISO: params.sinceISO,
        limit: params.limit,
      });
      return jsonResult({ ok: true, episodes: eps });
    },
  };
}
