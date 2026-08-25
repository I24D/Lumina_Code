import { describe, expect, it } from "vitest";

import {
  formatFindings,
  hasBlockingFinding,
  lintSkill,
  SKILL_INDEX_DESCRIPTION_LIMIT,
} from "./SkillLinter";

const VALID = {
  name: "Deploy to Render",
  slug: "deploy-to-render",
  description: "Deploy this service to Render and verify it is healthy",
  content:
    "## When to Use\n\nWhen shipping this service.\n\n## Steps\n\n1. Push to main.",
};

function rules(input: Parameters<typeof lintSkill>[0]) {
  return lintSkill(input).map((finding) => finding.rule);
}

describe("lintSkill", () => {
  it("passes a well-formed skill with no findings at all", () => {
    expect(lintSkill(VALID)).toEqual([]);
  });

  describe("blocking errors", () => {
    it.each([
      {
        description: "an empty name",
        input: { ...VALID, name: "   " },
        rule: "name-required",
      },
      {
        description: "a slug that is not directory-safe",
        input: { ...VALID, slug: "Deploy To Render" },
        rule: "name-format",
      },
      {
        description: "an empty description",
        input: { ...VALID, description: "" },
        rule: "description-required",
      },
      {
        description: "an empty body",
        input: { ...VALID, content: "\n\n" },
        rule: "content-required",
      },
    ])("refuses $description", ({ input, rule }) => {
      const findings = lintSkill(input);
      expect(findings.map((finding) => finding.rule)).toContain(rule);
      expect(hasBlockingFinding(findings)).toBe(true);
    });
  });

  describe("advisory warnings", () => {
    it("flags a missing 'When to Use' section without blocking the write", () => {
      const findings = lintSkill({
        ...VALID,
        content: "## Steps\n\n1. Push to main.",
      });
      expect(findings.map((finding) => finding.rule)).toEqual([
        "missing-when-to-use",
      ]);
      // The body still teaches something, so losing it would cost more than
      // the missing heading does.
      expect(hasBlockingFinding(findings)).toBe(false);
    });

    it("accepts any heading level for the 'When to Use' section", () => {
      expect(
        rules({ ...VALID, content: "#### when to use\n\nWhenever." }),
      ).not.toContain("missing-when-to-use");
    });

    it("flags a description the skill index would truncate", () => {
      const findings = lintSkill({
        ...VALID,
        description: "x".repeat(SKILL_INDEX_DESCRIPTION_LIMIT + 1),
      });
      expect(findings.map((finding) => finding.rule)).toContain(
        "description-too-long",
      );
      expect(hasBlockingFinding(findings)).toBe(false);
    });

    it("accepts a description exactly at the index limit", () => {
      expect(
        rules({
          ...VALID,
          description: "x".repeat(SKILL_INDEX_DESCRIPTION_LIMIT),
        }),
      ).not.toContain("description-too-long");
    });

    it("flags marketing language that displaces the trigger condition", () => {
      expect(
        rules({
          ...VALID,
          description: "A powerful and comprehensive deployment helper",
        }),
      ).toContain("description-marketing");
    });

    it("does not flag a marketing word buried inside a longer word", () => {
      // "robustness" is a legitimate technical noun; matching it would train
      // the agent to ignore this rule.
      expect(
        rules({ ...VALID, description: "Check robustness of the deploy" }),
      ).not.toContain("description-marketing");
    });
  });

  it("renders findings one per line with their severity", () => {
    const rendered = formatFindings(lintSkill({ ...VALID, description: "" }));
    expect(rendered).toContain("[error]");
    expect(rendered).toContain("description-required");
  });
});
