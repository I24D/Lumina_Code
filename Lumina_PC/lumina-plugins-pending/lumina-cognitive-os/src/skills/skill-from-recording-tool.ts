/**
 * skill-from-recording-tool.ts — Tool: lumina_recording_to_skill
 *
 * Wraps buildSkillFromRecording so the agent can package a recorded
 * demo into a reusable skill in one call.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { RecorderStore } from "../recorder/recorder-store.js";
import type { ActionLogStore } from "../memory/action-log.js";
import { buildSkillFromRecording } from "./skill-from-recording.js";

export function createSkillFromRecordingTool(deps: {
  recorderStore: RecorderStore;
  skillsDir: string;
  log: ActionLogStore | null;
}): AnyAgentTool {
  return {
    name: "lumina_recording_to_skill",
    label: "Lumina LfD — Recording to Skill",
    description:
      "Converts a Recorder session into an agentskills.io-compatible folder under c:/I24D_WhatsApp/skills/. " +
      "Generates SKILL.md (with metadata.lumina.type='learned-skill'), references/demo-summary.md, and " +
      "scripts/replay.json. After this, the skill is discoverable by lumina_skill_list within ~5s.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 80 }),
      skillName: Type.String({ minLength: 1, maxLength: 50, description: "Short human-readable name; will be kebab-cased and prefixed with `learned-`." }),
      description: Type.Optional(Type.String({ maxLength: 1024 })),
      strategy: Type.Optional(
        Type.Union([
          Type.Literal("naive_coords"),
          Type.Literal("window_relative"),
          Type.Literal("uia_grounded"),
          Type.Literal("vision_grounded"),
          Type.Literal("hybrid"),
        ], { default: "hybrid" }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("literal"), Type.Literal("abstracted")], { default: "literal" }),
      ),
    }),
    async execute(_id, p) {
      const sessionId = p.sessionId?.trim();
      const skillName = p.skillName?.trim();
      if (!sessionId) throw new ToolInputError("sessionId is required");
      if (!skillName) throw new ToolInputError("skillName is required");

      const result = buildSkillFromRecording(deps.recorderStore, {
        sessionId,
        skillName,
        description: p.description,
        strategy: p.strategy as string | undefined,
        mode: (p.mode as "literal" | "abstracted") ?? "literal",
        skillsDir: deps.skillsDir,
      });
      if (!result.ok) {
        deps.log?.append({
          action: "skill.from-recording.failed",
          target: `recording:${sessionId}`,
          result: "error",
          detail: result.error,
          source: "skill-from-recording",
        });
        return jsonResult({ ok: false, error: result.error });
      }
      deps.log?.append({
        action: "skill.from-recording",
        target: `skill:${result.skillId}`,
        result: "ok",
        detail: `built from recording '${sessionId}'`,
        source: "skill-from-recording",
        extra: { skillDir: result.skillDir },
      });
      return jsonResult({
        ok: true,
        skillId: result.skillId,
        skillDir: result.skillDir,
        skillFile: result.skillFile,
        hint:
          "The SkillLoader will pick this up automatically within ~5 seconds. " +
          "Call `lumina_skill_describe` with the new skillId to confirm.",
      });
    },
  };
}
