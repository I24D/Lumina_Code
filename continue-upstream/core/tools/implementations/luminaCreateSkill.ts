import type { ToolImpl } from ".";
import { formatFindings } from "../../learning/SkillLinter";
import {
  SkillWorkshopService,
  type SkillScope,
} from "../../learning/SkillWorkshopService";
import { getStringArg } from "../parseArgs";

/**
 * Agent-facing half of the same workshop the user sees in Settings. Both paths
 * lint, serialize and write through one service.
 */
export const luminaCreateSkillImpl: ToolImpl = async (args, extras) => {
  const name = getStringArg(args, "name");
  const description = getStringArg(args, "description");
  const content = getStringArg(args, "content");
  const scope: SkillScope =
    typeof args.scope === "string" &&
    args.scope.trim().toLowerCase() === "workspace"
      ? "workspace"
      : "global";
  const saved = await new SkillWorkshopService(extras.ide).save(
    { name, description, content, scope },
    { overwrite: args.overwrite === true, provenance: "agent" },
  );
  const warnings = saved.findings.filter(
    (finding) => finding.severity === "warning",
  );
  const advice =
    warnings.length > 0
      ? `\n\nWorth fixing next time this skill is edited:\n${formatFindings(warnings)}`
      : "";

  return [
    {
      name: `Skill ${saved.created ? "saved" : "updated"}: ${saved.skill.name}`,
      description: saved.skill.description,
      content:
        `${saved.created ? "Saved" : "Updated"} reusable skill (${scope} scope). ` +
        `Recall it with read_skill (skillName="${saved.skill.name}").\n` +
        `Path: ${saved.skill.path}${advice}`,
      uri: {
        type: "file",
        value: saved.skill.path,
      },
    },
  ];
};
