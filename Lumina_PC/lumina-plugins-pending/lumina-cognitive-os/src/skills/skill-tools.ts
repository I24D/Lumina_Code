/**
 * skill-tools.ts — Agent tools that expose the Agent Skills directory.
 *
 *   lumina_skill_list        — discovery; metadata only (cheap)
 *   lumina_skill_describe    — activation; full SKILL.md + resource list
 *   lumina_skill_read_asset  — resource tier; load one specific file
 *   lumina_skill_run         — build the activation prompt the caller
 *                              should pass to its preferred agent runtime
 *
 * Why split list / describe / run instead of one mega-tool: the
 * agentskills.io spec is explicit about progressive disclosure. Putting
 * the full SKILL.md into the discovery tool would defeat the purpose —
 * 100 skills × 5000 tokens each = a system prompt nobody wants.
 *
 * The `run` tool DOES NOT execute the skill. It returns the assembled
 * prompt so the caller (Start Talk, openclaw_agent_consult, the LLM
 * itself) can decide which runtime to feed it. This preserves every
 * existing approval / audit flow.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { SkillLoader } from "./skill-loader.js";
import { buildSkillActivationPrompt } from "./skill-runner.js";
import type { ActionLogStore } from "../memory/action-log.js";

const MAX_DESCRIBE_INSTRUCTIONS = 16_000; // refuse to dump 1 MB into a tool result

export function createSkillListTool(loader: SkillLoader): AnyAgentTool {
  return {
    name: "lumina_skill_list",
    label: "Lumina Skills — Discovery",
    description:
      "Lists every Agent Skill (https://agentskills.io standard) installed under the configured skills " +
      "directory. Returns ONLY name + description + light metadata — cheap to call. Use this BEFORE " +
      "lumina_skill_run to discover what's available, or when the user asks 'qué skills tienes', 'what " +
      "can you do for X', or wants to install/audit skills.",
    parameters: Type.Object({
      includeErrors: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Include skills that failed to load (with the load error), useful for debugging.",
        }),
      ),
    }),
    async execute(_id, params) {
      const skills = loader.list().map((skill) => ({
        id: skill.id,
        description: skill.description,
        version: skill.metadata.version ?? null,
        author: skill.metadata.author ?? null,
        license: skill.license ?? null,
        compatibility: skill.compatibility ?? null,
        allowedTools: skill.allowedTools,
        sourcePath: skill.skillFile,
      }));
      const payload: Record<string, unknown> = {
        ok: true,
        skillsDir: loader.dirForDebug(),
        count: skills.length,
        skills,
      };
      if (params.includeErrors) {
        payload.loadErrors = loader.errors();
      }
      return jsonResult(payload);
    },
  };
}

export function createSkillDescribeTool(loader: SkillLoader): AnyAgentTool {
  return {
    name: "lumina_skill_describe",
    label: "Lumina Skills — Activation",
    description:
      "Returns the FULL SKILL.md instructions for a named skill plus its resource manifest (scripts, " +
      "references, assets — paths only, NOT contents). Call this when you've decided to activate a " +
      "skill discovered via lumina_skill_list. After reading the instructions, follow them — calling " +
      "lumina_skill_read_asset only for the specific files SKILL.md references.",
    parameters: Type.Object({
      skillId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    async execute(_id, params) {
      const id = params.skillId?.trim();
      if (!id) throw new ToolInputError("skillId is required");
      const skill = loader.get(id);
      if (!skill) {
        return jsonResult({
          ok: false,
          error: `skill '${id}' not found`,
          hint: "Call lumina_skill_list to see what's installed, or drop a SKILL.md into " + loader.dirForDebug(),
        });
      }
      const instructions = skill.instructions.length > MAX_DESCRIBE_INSTRUCTIONS
        ? skill.instructions.slice(0, MAX_DESCRIBE_INSTRUCTIONS) +
          `\n\n[truncated — ${skill.instructions.length - MAX_DESCRIBE_INSTRUCTIONS} more chars in ${skill.skillFile}]`
        : skill.instructions;
      return jsonResult({
        ok: true,
        skill: {
          id: skill.id,
          description: skill.description,
          license: skill.license ?? null,
          compatibility: skill.compatibility ?? null,
          allowedTools: skill.allowedTools,
          metadata: skill.metadata,
          sourcePath: skill.skillFile,
          instructions,
          scripts: skill.scripts.map((r) => ({ path: r.relPath, sizeBytes: r.sizeBytes })),
          references: skill.references.map((r) => ({ path: r.relPath, sizeBytes: r.sizeBytes })),
          assets: skill.assets.map((r) => ({ path: r.relPath, sizeBytes: r.sizeBytes })),
        },
      });
    },
  };
}

export function createSkillReadAssetTool(loader: SkillLoader): AnyAgentTool {
  return {
    name: "lumina_skill_read_asset",
    label: "Lumina Skills — Read Resource",
    description:
      "Reads ONE bundled file (script, reference, or asset) from a skill, with path safety. The path " +
      "must be relative to the skill folder; .. and absolute paths are rejected. Files > maxBytes are " +
      "rejected. Use binary=true to base64-encode non-text resources. Use sparingly — agents should " +
      "load only the files SKILL.md explicitly references for the current task.",
    parameters: Type.Object({
      skillId: Type.String({ minLength: 1, maxLength: 64 }),
      relPath: Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Path inside the skill folder, e.g. 'scripts/extract.py' or 'references/REFERENCE.md'.",
      }),
      maxBytes: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 4 * 1024 * 1024,
          default: 256 * 1024,
        }),
      ),
      binary: Type.Optional(
        Type.Boolean({ default: false, description: "If true, return base64; otherwise utf-8 text." }),
      ),
    }),
    async execute(_id, params) {
      const id = params.skillId?.trim();
      const rel = params.relPath?.trim();
      if (!id) throw new ToolInputError("skillId is required");
      if (!rel) throw new ToolInputError("relPath is required");
      const result = loader.readAsset(id, rel, {
        maxBytes: params.maxBytes,
        encoding: params.binary ? "binary" : "utf8",
      });
      if (!result.ok) {
        return jsonResult({ ok: false, error: result.error, skillId: id, relPath: rel });
      }
      return jsonResult({
        ok: true,
        skillId: id,
        relPath: rel,
        sizeBytes: result.bytes,
        encoding: params.binary ? "base64" : "utf-8",
        content: result.content,
      });
    },
  };
}

export function createSkillRunTool(
  loader: SkillLoader,
  log: ActionLogStore | null,
): AnyAgentTool {
  return {
    name: "lumina_skill_run",
    label: "Lumina Skills — Build Activation Prompt",
    description:
      "Builds the activation prompt for a skill: full SKILL.md instructions + the user's input + the " +
      "resource manifest + the skill's allowed-tools. RETURNS the prompt; DOES NOT call any sub-agent. " +
      "After receiving the result, YOU should follow the preamble's instructions yourself (so existing " +
      "approval/audit semantics apply). For Start Talk live voice this is the path; for tasks that need " +
      "PC tools you can pass the preamble to openclaw_agent_consult via extraSystemPrompt.",
    parameters: Type.Object({
      skillId: Type.String({ minLength: 1, maxLength: 64 }),
      input: Type.Optional(Type.String({ maxLength: 8_000, default: "" })),
      extraContext: Type.Optional(Type.String({ maxLength: 8_000 })),
    }),
    async execute(_id, params) {
      const id = params.skillId?.trim();
      if (!id) throw new ToolInputError("skillId is required");
      const skill = loader.get(id);
      if (!skill) {
        return jsonResult({
          ok: false,
          error: `skill '${id}' not found`,
          hint: "Call lumina_skill_list first.",
        });
      }
      const prompt = buildSkillActivationPrompt({
        skill,
        input: params.input ?? "",
        extraContext: params.extraContext,
      });
      if (log) {
        log.append({
          action: "skill.activate",
          target: `skill:${skill.id}`,
          result: "ok",
          detail: prompt.userMessage.slice(0, 160),
          source: "skill-runner",
          extra: {
            allowedTools: prompt.allowedTools,
            resourceCount: prompt.resourceManifest.length,
          },
        });
      }
      return jsonResult({
        ok: true,
        skillId: prompt.skillId,
        preamble: prompt.preamble,
        userMessage: prompt.userMessage,
        allowedTools: prompt.allowedTools,
        resourceManifest: prompt.resourceManifest,
        hint:
          "Apply the preamble as your system context for this turn. Follow the SKILL.md instructions " +
          "verbatim. Call lumina_skill_read_asset(skillId, relPath) ONLY when the instructions reference " +
          "a specific file.",
      });
    },
  };
}
