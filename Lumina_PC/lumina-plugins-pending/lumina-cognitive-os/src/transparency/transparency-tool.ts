/**
 * transparency-tool.ts — Tools the agent uses to publish what it's doing
 * so the UI panel can display it in real time.
 *
 *   lumina_transparency_publish  — push one entry
 *   lumina_transparency_recent   — read the last N (the UI also reads this)
 *
 * The agent SHOULD call publish at the start of every notable step
 * ("I'm about to open Chrome and go to youtube.com", "running 3 tests").
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { ActivityLog, ActivityCategory } from "./activity-log.js";

const CATEGORIES: ReadonlyArray<ActivityCategory> = [
  "intent",
  "tool",
  "app",
  "agent",
  "file",
  "email",
  "page",
  "command",
  "risk",
  "memory",
];

export function createTransparencyPublishTool(log: ActivityLog): AnyAgentTool {
  return {
    name: "lumina_transparency_publish",
    label: "Lumina Transparency — Publish",
    description:
      "Append one user-visible activity entry: 'about to send the report email', 'opening Chrome to youtube.com', " +
      "'running the test suite'. Call this BEFORE the actual tool call so the user sees Lumina's intention before " +
      "the effect — that's what makes the cognitive OS trustworthy.",
    parameters: Type.Object({
      category: Type.Union(CATEGORIES.map((c) => Type.Literal(c))),
      summary: Type.String({ minLength: 1, maxLength: 240 }),
      detail: Type.Optional(Type.String({ maxLength: 1200 })),
      risk: Type.Optional(
        Type.Union([
          Type.Literal("SAFE"),
          Type.Literal("WARNING"),
          Type.Literal("HIGH_RISK"),
          Type.Literal("CRITICAL"),
        ]),
      ),
      ref: Type.Optional(Type.Unknown()),
    }),
    async execute(_id, params) {
      const summary = params.summary?.trim();
      if (!summary) throw new ToolInputError("summary is required");
      const entry = log.push({
        category: params.category as ActivityCategory,
        summary,
        detail: params.detail,
        risk: params.risk,
        ref: params.ref as Record<string, unknown> | undefined,
      });
      return jsonResult({ ok: true, entry });
    },
  };
}

export function createTransparencyRecentTool(log: ActivityLog): AnyAgentTool {
  return {
    name: "lumina_transparency_recent",
    label: "Lumina Transparency — Recent",
    description:
      "Returns the last N transparency entries (or filtered by category). Used by the UI panel and by the agent " +
      "itself when the user asks 'qué has hecho recientemente'.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 256, default: 32 })),
      category: Type.Optional(Type.Union(CATEGORIES.map((c) => Type.Literal(c)))),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 32;
      const entries = params.category
        ? log.byCategory(params.category as ActivityCategory, limit)
        : log.recent(limit);
      return jsonResult({ ok: true, entries });
    },
  };
}
