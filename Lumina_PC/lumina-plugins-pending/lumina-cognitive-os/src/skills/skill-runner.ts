/**
 * skill-runner.ts — Activation prompt builder.
 *
 * When a skill activates, the agent that consumes it (Gemini Live, Claude,
 * Codex, the embedded pi agent) is sent the full `SKILL.md` instructions
 * PLUS the user's input PLUS a manifest of available resources (script
 * paths, reference paths, asset paths). The runner does NOT call any
 * sub-agent itself — it returns the assembled prompt so the caller can
 * decide where to send it:
 *
 *   - Gemini direct (Start Talk live voice path)
 *   - openclaw_agent_consult (when the skill needs PC tools)
 *   - lumina_director_route (when the skill is multi-step)
 *
 * Keeping the runner side-effect-free means the Risk Engine and approval
 * flows that live one layer up keep working unchanged.
 */
import type { Skill, SkillResource } from "./skill-loader.js";

export type SkillActivationPrompt = {
  /** What to feed the model as a system / preamble block. */
  readonly preamble: string;
  /** What to send as the user-visible message (kept short). */
  readonly userMessage: string;
  /** Tools the skill is pre-approved to use (from `allowed-tools:`). */
  readonly allowedTools: ReadonlyArray<string>;
  /** Resources the model can request on demand (paths only, NOT contents). */
  readonly resourceManifest: ReadonlyArray<{ kind: "script" | "reference" | "asset"; path: string; sizeBytes: number }>;
  /** The skill metadata for logging / observability. */
  readonly skillId: string;
};

const MAX_INPUT_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 32_000; // ≈ 8k tokens — well above spec recommendation of <5k tokens

export function buildSkillActivationPrompt(params: {
  skill: Skill;
  input: string;
  extraContext?: string;
}): SkillActivationPrompt {
  const input = (params.input ?? "").slice(0, MAX_INPUT_CHARS).trim();
  const extraContext = (params.extraContext ?? "").slice(0, MAX_INPUT_CHARS).trim();
  const instructions = params.skill.instructions.slice(0, MAX_INSTRUCTIONS_CHARS).trim();

  const manifest = [
    ...mapResources(params.skill.scripts, "script"),
    ...mapResources(params.skill.references, "reference"),
    ...mapResources(params.skill.assets, "asset"),
  ];

  const preambleLines: string[] = [
    `You are operating the Agent Skill '${params.skill.id}'.`,
    `Skill description (from SKILL.md):`,
    params.skill.description,
    "",
    "─── SKILL INSTRUCTIONS (verbatim from SKILL.md) ───",
    instructions,
    "─── END SKILL INSTRUCTIONS ───",
  ];

  if (manifest.length > 0) {
    preambleLines.push(
      "",
      "Bundled resources you may request via `lumina_skill_read_asset(skillId, path)`:",
      ...manifest.map((m) => `  - [${m.kind}] ${m.path} (${m.sizeBytes} bytes)`),
    );
  }

  if (params.skill.compatibility) {
    preambleLines.push("", `Compatibility note from SKILL.md: ${params.skill.compatibility}`);
  }

  if (params.skill.allowedTools.length > 0) {
    preambleLines.push(
      "",
      `Pre-approved tools for this skill (per SKILL.md \`allowed-tools\`): ${params.skill.allowedTools.join(" ")}`,
    );
  }

  if (extraContext) {
    preambleLines.push("", "Additional realtime context from the caller:", extraContext);
  }

  return {
    preamble: preambleLines.join("\n"),
    userMessage: input || `(no input provided; follow SKILL.md as written)`,
    allowedTools: params.skill.allowedTools,
    resourceManifest: manifest,
    skillId: params.skill.id,
  };
}

function mapResources(
  list: ReadonlyArray<SkillResource>,
  kind: "script" | "reference" | "asset",
): Array<{ kind: "script" | "reference" | "asset"; path: string; sizeBytes: number }> {
  return list.map((r) => ({ kind, path: r.relPath, sizeBytes: r.sizeBytes }));
}
