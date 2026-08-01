import { GeneratedSkill, LearnedPattern } from "./types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
}

export class SkillGenerator {
  generate(pattern: LearnedPattern): GeneratedSkill {
    const name = slugify(pattern.name) || "learned-pattern";
    const steps = pattern.actions
      .map((action, index) => `${index + 1}. ${action.type} ${action.target ?? action.value ?? ""}`.trim())
      .join("\n");
    return {
      name,
      patternId: pattern.id,
      markdown: [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(`Learned user pattern with confidence ${pattern.confidence}`)}`,
        "---",
        "",
        "# Learned Pattern",
        "",
        steps,
        "",
      ].join("\n"),
    };
  }
}
