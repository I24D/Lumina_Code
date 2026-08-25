import { GetTool, Skill } from "../..";
import { loadMarkdownSkills } from "../../config/markdown/loadMarkdownSkills";
import { SKILL_INDEX_DESCRIPTION_LIMIT } from "../../learning/SkillLinter";
import { getSkillUsageStore } from "../../learning/SkillUsageStore";
import { SkillUsageView } from "../../learning/types";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

/**
 * Builds the skill index the model reads when choosing whether to open a
 * skill. This is the progressive-disclosure half of procedural memory: names
 * and descriptions ride along on every request, bodies are only paid for when
 * read_skill is actually called. That budget is why descriptions are truncated
 * and archived skills are left out.
 *
 * Ordering is by proven usage, so skills that keep earning their keep are the
 * ones the model sees first when the list gets long.
 */
export function renderSkillIndex(
  skills: Skill[],
  usage: SkillUsageView[] = getSkillUsageStore().viewAll(),
): string {
  if (skills.length === 0) {
    return "No skills are available yet. Use the create_skill tool to record one after solving a non-trivial task.";
  }

  const usageByName = new Map(usage.map((view) => [view.name, view]));

  const visible = skills.filter(
    (skill) => usageByName.get(skill.name)?.state !== "archived",
  );

  if (visible.length === 0) {
    return "Every known skill is archived. Use the create_skill tool to record a new one.";
  }

  return visible
    .map((skill) => ({
      skill,
      useCount: usageByName.get(skill.name)?.useCount ?? 0,
      lastActivityAt: usageByName.get(skill.name)?.lastActivityAt ?? "",
    }))
    .sort(
      (a, b) =>
        b.useCount - a.useCount ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.skill.name.localeCompare(b.skill.name),
    )
    .map(({ skill }) => {
      const description =
        skill.description.length > SKILL_INDEX_DESCRIPTION_LIMIT
          ? `${skill.description.slice(0, SKILL_INDEX_DESCRIPTION_LIMIT - 1).trimEnd()}…`
          : skill.description;
      return `name: ${skill.name}\ndescription: ${description}`;
    })
    .join("\n\n");
}

export const readSkillTool: GetTool = async (params) => {
  const { skills } = await loadMarkdownSkills(params.ide);
  return {
    type: "function",
    displayTitle: "Read Skill",
    wouldLikeTo: "read skill {{{ skillName }}}",
    isCurrently: "reading skill {{{ skillName }}}",
    hasAlready: "read skill {{{ skillName }}}",
    readonly: true,
    isInstant: true,
    group: BUILT_IN_GROUP_NAME,
    function: {
      name: BuiltInToolNames.ReadSkill,
      description: `Use this tool to read the content of a skill by its name. Skills contain detailed instructions for specific tasks. The skill name should match one of the available skills listed below:

${renderSkillIndex(skills)}`,
      parameters: {
        type: "object",
        required: ["skillName"],
        properties: {
          skillName: {
            type: "string",
            description:
              "The name of the skill to read. This should match the name from the available skills.",
          },
        },
      },
    },
  };
};
