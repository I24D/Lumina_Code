import { ToolImpl } from ".";
import { loadMarkdownSkills } from "../../config/markdown/loadMarkdownSkills";
import { getSkillUsageStore } from "../../learning/SkillUsageStore";
import { SkillUsageView } from "../../learning/types";
import { getStringArg } from "../parseArgs";

const ACTIONS = ["list", "archive", "unarchive", "pin", "unpin"] as const;
type ManageSkillsAction = (typeof ACTIONS)[number];

const PAST_TENSE: Record<Exclude<ManageSkillsAction, "list">, string> = {
  archive: "archived",
  unarchive: "unarchived",
  pin: "pinned",
  unpin: "unpinned",
};

function describe(name: string, usage: SkillUsageView | undefined): string {
  if (!usage) {
    return `- ${name} — never used yet`;
  }
  const parts = [
    `used ${usage.useCount}×`,
    usage.patchCount > 0 ? `revised ${usage.patchCount}×` : undefined,
    usage.createdBy === "agent" ? "written by Lumina" : "written by hand",
    usage.state !== "active" ? usage.state : undefined,
    usage.pinned ? "pinned" : undefined,
    usage.lastUsedAt
      ? `last used ${usage.lastUsedAt.slice(0, 10)}`
      : "never used",
  ].filter(Boolean);
  return `- ${name} — ${parts.join(", ")}`;
}

/**
 * manage_skills — list and curate procedural memory.
 *
 * The skill list is built from the SKILL.md files on disk rather than from the
 * usage file, so a skill is reported even when it has no telemetry yet, and a
 * stale telemetry entry for a deleted skill never shows up as a phantom.
 */
export const manageSkillsImpl: ToolImpl = async (args, extras) => {
  const rawAction = getStringArg(args, "action").trim().toLowerCase();
  if (!ACTIONS.includes(rawAction as ManageSkillsAction)) {
    throw new Error(
      `Unknown action "${rawAction}". Expected one of: ${ACTIONS.join(", ")}.`,
    );
  }
  const action = rawAction as ManageSkillsAction;
  const store = getSkillUsageStore();
  const { skills } = await loadMarkdownSkills(extras.ide);

  if (action === "list") {
    if (skills.length === 0) {
      return [
        {
          name: "No skills yet",
          description: "",
          content:
            "Lumina has not learned any skills yet. After solving a non-trivial " +
            "multi-step task, use create_skill to record the procedure.",
        },
      ];
    }
    const usageByName = new Map(
      store.viewAll().map((view) => [view.name, view]),
    );
    const lines = skills
      .map((skill) => ({
        skill,
        usage: usageByName.get(skill.name),
      }))
      .sort(
        (a, b) =>
          (b.usage?.useCount ?? 0) - (a.usage?.useCount ?? 0) ||
          a.skill.name.localeCompare(b.skill.name),
      )
      .map(({ skill, usage }) => describe(skill.name, usage));

    return [
      {
        name: `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
        description: "Procedural memory, most-used first",
        content: lines.join("\n"),
      },
    ];
  }

  const skillName = getStringArg(args, "skillName");
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    throw new Error(
      `Skill "${skillName}" not found. Available: ${
        skills.map((candidate) => candidate.name).join(", ") || "none"
      }.`,
    );
  }

  switch (action) {
    case "archive":
      store.setArchived(skill.name, true);
      break;
    case "unarchive":
      store.setArchived(skill.name, false);
      break;
    case "pin":
      store.setPinned(skill.name, true);
      break;
    case "unpin":
      store.setPinned(skill.name, false);
      break;
  }

  const updated = store.get(skill.name);
  return [
    {
      name: `Skill ${PAST_TENSE[action]}: ${skill.name}`,
      description: skill.description,
      content:
        `${describe(skill.name, updated)}\n` +
        (action === "archive"
          ? "It no longer appears in the skill index. read_skill can still open it by name, and using it again un-archives it."
          : ""),
    },
  ];
};
