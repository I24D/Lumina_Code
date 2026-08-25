import type { Skill } from "core";
import { describe, expect, it } from "vitest";

import type { RootState } from "../store";
import { selectSkillSlashCommands, skillCommandSlug } from "./index";

function stateWith(skills: Skill[]): RootState {
  return { config: { config: { skills } } } as unknown as RootState;
}

function skill(name: string, description = `use ${name}`): Skill {
  return { name, description, path: `/skills/x/SKILL.md`, content: "", files: [] };
}

describe("skillCommandSlug", () => {
  it.each([
    ["Deploy to Render", "deploy-to-render"],
    ["cn_check", "cn-check"],
    ["Build & Ship!", "build-ship"],
    ["  Padded  Name  ", "padded-name"],
    ["C++ Notes", "c-notes"],
  ])("turns %j into %j", (name, expected) => {
    expect(skillCommandSlug(name)).toBe(expected);
  });

  it("collapses the runs of hyphens that stripping punctuation leaves behind", () => {
    expect(skillCommandSlug("a + / b")).toBe("a-b");
  });

  it("returns empty for a name with nothing usable in it", () => {
    expect(skillCommandSlug("+++")).toBe("");
  });
});

describe("selectSkillSlashCommands", () => {
  it("offers each skill as a slash command", () => {
    const items = selectSkillSlashCommands(
      stateWith([skill("Deploy to Render")]),
    );

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("/deploy-to-render");
    expect(items[0].description).toBe("use Deploy to Render");
    // Must be a prompt, not an action: the user types their instruction after
    // picking the skill.
    expect(items[0].type).toBe("slashCommand");
  });

  it("routes through read_skill instead of pasting the skill body", () => {
    const items = selectSkillSlashCommands(
      stateWith([skill("Deploy to Render")]),
    );

    // Going through the tool is what records the skill as used.
    expect(items[0].content).toContain("read_skill");
    expect(items[0].content).toContain("Deploy to Render");
  });

  it("gives the first claimant a colliding command rather than dropping both", () => {
    const items = selectSkillSlashCommands(
      stateWith([skill("Deploy To Render"), skill("deploy_to_render")]),
    );

    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("use Deploy To Render");
  });

  it("skips a skill whose name yields no usable command", () => {
    expect(selectSkillSlashCommands(stateWith([skill("+++")]))).toEqual([]);
  });

  it("returns nothing when there are no skills", () => {
    expect(selectSkillSlashCommands(stateWith([]))).toEqual([]);
  });
});
