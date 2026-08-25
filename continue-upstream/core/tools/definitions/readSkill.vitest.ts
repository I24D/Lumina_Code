import { describe, expect, it } from "vitest";

import { Skill } from "../..";
import { SKILL_INDEX_DESCRIPTION_LIMIT } from "../../learning/SkillLinter";
import { SkillUsageView } from "../../learning/types";

import { renderSkillIndex } from "./readSkill";

function skill(name: string, description = `use ${name}`): Skill {
  return { name, description, path: `/skills/${name}`, content: "", files: [] };
}

function usage(
  name: string,
  overrides: Partial<SkillUsageView> = {},
): SkillUsageView {
  return {
    name,
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    useCount: 0,
    patchCount: 0,
    pinned: false,
    state: "active",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderSkillIndex", () => {
  it("tells the model how to create one when there are none", () => {
    expect(renderSkillIndex([], [])).toContain("create_skill");
  });

  it("separates entries with a blank line and no stray punctuation", () => {
    // Interpolating the array directly used to join entries with commas,
    // leaving a bare "," between skills in the tool description.
    const rendered = renderSkillIndex([skill("alpha"), skill("beta")], []);

    expect(rendered).toBe(
      "name: alpha\ndescription: use alpha\n\nname: beta\ndescription: use beta",
    );
    expect(rendered).not.toContain(",");
  });

  it("puts proven skills first so a long list stays useful", () => {
    const rendered = renderSkillIndex(
      [skill("rarely"), skill("often")],
      [usage("often", { useCount: 12 }), usage("rarely", { useCount: 1 })],
    );

    expect(rendered.indexOf("name: often")).toBeLessThan(
      rendered.indexOf("name: rarely"),
    );
  });

  it("breaks ties on recency, then on name", () => {
    const rendered = renderSkillIndex(
      [skill("b"), skill("a"), skill("c")],
      [
        usage("a", { lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        usage("b", { lastActivityAt: "2026-06-01T00:00:00.000Z" }),
        usage("c", { lastActivityAt: "2026-06-01T00:00:00.000Z" }),
      ],
    );
    const order = ["b", "c", "a"].map((name) =>
      rendered.indexOf(`name: ${name}`),
    );

    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("truncates a description that would cost tokens on every request", () => {
    const long = "x".repeat(SKILL_INDEX_DESCRIPTION_LIMIT + 50);
    const rendered = renderSkillIndex([skill("verbose", long)], []);

    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThan(long.length);
  });

  it("leaves a description at the limit untouched", () => {
    const exact = "x".repeat(SKILL_INDEX_DESCRIPTION_LIMIT);
    expect(renderSkillIndex([skill("exact", exact)], [])).toContain(exact);
  });

  it("omits archived skills without claiming there are none", () => {
    const rendered = renderSkillIndex(
      [skill("kept"), skill("shelved")],
      [usage("shelved", { state: "archived" })],
    );

    expect(rendered).toContain("name: kept");
    expect(rendered).not.toContain("name: shelved");
  });

  it("says so when every skill is archived", () => {
    const rendered = renderSkillIndex(
      [skill("shelved")],
      [usage("shelved", { state: "archived" })],
    );

    // "No skills exist" would be a lie that hides recoverable work.
    expect(rendered).toContain("archived");
    expect(rendered).toContain("create_skill");
  });

  it("lists a skill that has no telemetry yet", () => {
    expect(renderSkillIndex([skill("brand-new")], [])).toContain(
      "name: brand-new",
    );
  });
});
