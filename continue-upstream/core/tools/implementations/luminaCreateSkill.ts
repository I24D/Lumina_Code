import { ToolImpl } from ".";
import {
  formatFindings,
  hasBlockingFinding,
  lintSkill,
} from "../../learning/SkillLinter";
import { getSkillUsageStore } from "../../learning/SkillUsageStore";
import { getGlobalFolderWithName } from "../../util/paths";
import { localPathToUri } from "../../util/pathToUri";
import { joinPathsToUri } from "../../util/uri";
import { getStringArg } from "../parseArgs";

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug || "skill";
}

/**
 * create_skill — the Hermes "grows with you" loop for Lumina Code. Persists a
 * learned procedure as a SKILL.md file that read_skill can recall later. Written
 * in the same format loadMarkdownSkills expects (frontmatter name/description +
 * markdown body), so the new skill immediately shows up as recallable.
 *
 * Writing the file is only half the loop. Every write is linted first, and
 * every write is recorded against the skill's telemetry, so procedural memory
 * can later be ranked by what actually gets used instead of growing forever.
 */
export const luminaCreateSkillImpl: ToolImpl = async (args, extras) => {
  const name = getStringArg(args, "name");
  const description = getStringArg(args, "description");
  const content = getStringArg(args, "content");
  const scope =
    typeof args.scope === "string" &&
    args.scope.trim().toLowerCase() === "workspace"
      ? "workspace"
      : "global";
  const overwrite = args.overwrite === true;

  const slug = slugify(name);

  const findings = lintSkill({ name, description, content, slug });
  if (hasBlockingFinding(findings)) {
    throw new Error(
      `This skill cannot be saved as written:\n${formatFindings(findings)}`,
    );
  }

  let dirUri: string;
  if (scope === "workspace") {
    const dirs = await extras.ide.getWorkspaceDirs();
    if (!dirs.length) {
      throw new Error(
        "No workspace is open — use scope 'global' to save this skill.",
      );
    }
    dirUri = joinPathsToUri(dirs[0], ".continue", "skills", slug);
  } else {
    dirUri = joinPathsToUri(
      localPathToUri(getGlobalFolderWithName("skills")),
      slug,
    );
  }
  const fileUri = joinPathsToUri(dirUri, "SKILL.md");

  const exists = await extras.ide.fileExists(fileUri);
  if (exists && !overwrite) {
    throw new Error(
      `A skill named "${slug}" already exists. Pass overwrite=true to replace it, or choose a different name.`,
    );
  }

  // Escape frontmatter-breaking characters in the one-line fields.
  const safeName = name.replace(/\r?\n/gu, " ").trim();
  const safeDescription = description.replace(/\r?\n/gu, " ").trim();
  const markdown = `---\nname: ${safeName}\ndescription: ${safeDescription}\n---\n\n${content.trim()}\n`;

  await extras.ide.writeFile(fileUri, markdown);

  // Telemetry is keyed by the frontmatter name because that is the handle
  // read_skill recalls by, and the one the user sees in settings.
  const usage = getSkillUsageStore();
  if (exists) {
    usage.recordPatch(safeName);
  } else {
    usage.recordCreate(safeName, "agent");
  }

  const warnings = findings.filter((finding) => finding.severity === "warning");
  const advice =
    warnings.length > 0
      ? `\n\nWorth fixing next time this skill is edited:\n${formatFindings(warnings)}`
      : "";

  return [
    {
      name: `Skill ${exists ? "updated" : "saved"}: ${safeName}`,
      description: safeDescription,
      content:
        `${exists ? "Updated" : "Saved"} reusable skill "${slug}" (${scope} scope). ` +
        `Recall it any time with read_skill (skillName="${safeName}").\nPath: ${fileUri}${advice}`,
      uri: {
        type: "file",
        value: fileUri,
      },
    },
  ];
};
