import { SkillLintFinding } from "./types.js";

/**
 * How much of a description the skill index will show before truncating. A
 * description is a routing hint — "when should I reach for this?" — so past
 * this length it stops helping the model choose and starts costing tokens on
 * every single request.
 */
export const SKILL_INDEX_DESCRIPTION_LIMIT = 240;

/** Skill names must be recallable by read_skill, so keep them slug-shaped. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/**
 * Words that describe how a skill feels rather than when to use it. They read
 * as filler to a model choosing between twenty skills, and they crowd out the
 * trigger conditions that actually drive the choice.
 */
const MARKETING_WORDS = [
  "powerful",
  "comprehensive",
  "seamless",
  "advanced",
  "cutting-edge",
  "state-of-the-art",
  "revolutionary",
  "robust",
];

const WHEN_TO_USE_HEADING = /^\s*#{1,6}\s*when to use\b/imu;

export interface SkillLintInput {
  name: string;
  description: string;
  content: string;
  /** Directory slug the skill will be written to, when it differs from name. */
  slug?: string;
}

/**
 * Checks a skill before it is written to disk.
 *
 * Ported from Hermes's skill linter, keeping only the rules that mean
 * something for Lumina's skill format. Hermes also validates fields Lumina's
 * SKILL.md does not carry (metadata.hermes.tags, platforms, POSIX script
 * audits); porting those would fire a warning on every legitimate skill here,
 * which trains the agent to ignore the linter.
 *
 * Severity is the whole point of the split: `error` means the skill would not
 * load, or would load under a name nothing can recall, so the write is
 * refused. Everything else is advice handed back so the next revision is
 * better — never a reason to lose work the agent just did.
 */
export function lintSkill(input: SkillLintInput): SkillLintFinding[] {
  const findings: SkillLintFinding[] = [];
  const name = input.name.trim();
  const description = input.description.trim();
  const content = input.content.trim();

  if (name === "") {
    findings.push({
      severity: "error",
      rule: "name-required",
      message: "A skill needs a name — read_skill has no other way to find it.",
    });
  }

  const slug = input.slug?.trim();
  if (slug !== undefined && slug !== "" && !SKILL_NAME_PATTERN.test(slug)) {
    findings.push({
      severity: "error",
      rule: "name-format",
      message:
        `"${name}" does not reduce to a usable directory name. Use lowercase ` +
        "letters, digits, hyphens or underscores, starting with a letter or digit.",
    });
  }

  if (description === "") {
    findings.push({
      severity: "error",
      rule: "description-required",
      message:
        "A skill needs a one-line description saying when to use it — it is " +
        "the only thing the model sees when deciding whether to open the skill.",
    });
  } else if (description.length > SKILL_INDEX_DESCRIPTION_LIMIT) {
    findings.push({
      severity: "warning",
      rule: "description-too-long",
      message:
        `The description is ${description.length} characters and the skill ` +
        `index truncates at ${SKILL_INDEX_DESCRIPTION_LIMIT}. Lead with the ` +
        "trigger condition so nothing load-bearing is cut.",
    });
  }

  const marketing = MARKETING_WORDS.filter((word) =>
    new RegExp(`\\b${word}\\b`, "iu").test(description),
  );
  if (marketing.length > 0) {
    findings.push({
      severity: "warning",
      rule: "description-marketing",
      message:
        `The description sells the skill (${marketing.join(", ")}) instead of ` +
        "saying when to use it. Describe the trigger, not the quality.",
    });
  }

  if (content === "") {
    findings.push({
      severity: "error",
      rule: "content-required",
      message: "A skill with an empty body teaches nothing when recalled.",
    });
  } else if (!WHEN_TO_USE_HEADING.test(content)) {
    findings.push({
      severity: "warning",
      rule: "missing-when-to-use",
      message:
        'Add a "## When to Use" section. Without it the body explains how but ' +
        "never says under what conditions to apply it.",
    });
  }

  return findings;
}

export function hasBlockingFinding(findings: SkillLintFinding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}

/** Renders findings for a tool result or an error message. */
export function formatFindings(findings: SkillLintFinding[]): string {
  return findings
    .map(
      (finding) =>
        `- [${finding.severity}] ${finding.rule}: ${finding.message}`,
    )
    .join("\n");
}
