import {
  ConfigValidationError,
  parseMarkdownRule,
} from "@continuedev/config-yaml";
import z from "zod";
import { IDE, Skill } from "../..";
import { walkDir } from "../../indexing/walkDir";
import { localPathToUri } from "../../util/pathToUri";
import { getGlobalFolderWithName } from "../../util/paths";
import { findUriInDirs, joinPathsToUri } from "../../util/uri";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import { getEnabledPluginSkillFiles } from "../PluginCatalogService";

const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const SKILLS_DIR = "skills";

/**
 * Extra skill libraries outside the workspace/global .continue and .claude
 * folders, provided as absolute paths in the LUMINA_SKILLS_DIR env var
 * (comma-separated). This lets Lumina Code reuse the shared I24D_WhatsApp skill
 * library (SKILL.md format) without copying files.
 * Unset env → no extra dirs → behaviour unchanged.
 */
async function getLuminaExtraSkillFiles(ide: IDE): Promise<string[]> {
  const raw = process.env.LUMINA_SKILLS_DIR ?? "";
  const paths = raw
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    return [];
  }
  return (
    await Promise.all(
      paths.map(async (localPath) => {
        const dir = localPathToUri(localPath);
        const exists = await ide.fileExists(dir);
        if (!exists) return [];
        const uris = await walkDir(dir, ide, {
          source: "get lumina extra skills files",
        });
        return uris.filter((uri) => uri.endsWith(".md"));
      }),
    )
  ).flat();
}

/**
 * Get skills from .claude/skills directory
 */
async function getClaudeSkillsDir(ide: IDE) {
  const fullDirs = (await ide.getWorkspaceDirs()).map((dir) =>
    joinPathsToUri(dir, ".claude", SKILLS_DIR),
  );

  fullDirs.push(localPathToUri(getGlobalFolderWithName(SKILLS_DIR)));

  return (
    await Promise.all(
      fullDirs.map(async (dir) => {
        const exists = await ide.fileExists(dir);
        if (!exists) return [];
        const uris = await walkDir(dir, ide, {
          source: "get .claude skills files",
        });
        // filter markdown files only
        return uris.filter((uri) => uri.endsWith(".md"));
      }),
    )
  ).flat();
}

export async function loadMarkdownSkills(ide: IDE) {
  const errors: ConfigValidationError[] = [];
  const skills: Skill[] = [];

  try {
    const yamlAndMarkdownFileUris = [
      ...(
        await getAllDotContinueDefinitionFiles(
          ide,
          {
            includeGlobal: true,
            includeWorkspace: true,
            fileExtType: "markdown",
          },
          SKILLS_DIR,
        )
      ).map((file) => file.path),
      ...(await getClaudeSkillsDir(ide)),
      ...(await getLuminaExtraSkillFiles(ide)),
      ...(await getEnabledPluginSkillFiles(ide)),
    ];

    const skillFiles = yamlAndMarkdownFileUris.filter((path) =>
      path.endsWith("SKILL.md"),
    );

    const workspaceDirs = await ide.getWorkspaceDirs();
    for (const fileUri of skillFiles) {
      try {
        const content = await ide.readFile(fileUri);
        const { frontmatter, markdown } = parseMarkdownRule(
          content,
        ) as unknown as { frontmatter: Skill; markdown: string };

        const validatedFrontmatter = skillFrontmatterSchema.parse(frontmatter);

        const filesInSkillsDirectory = (
          await walkDir(fileUri.substring(0, fileUri.lastIndexOf("/")), ide, {
            source: "get skill files",
          })
        )
          // do not include SKILL.md as it is already in content
          .filter((file) => !file.endsWith("SKILL.md"));

        const foundRelativeUri = findUriInDirs(fileUri, workspaceDirs);

        skills.push({
          ...validatedFrontmatter,
          content: markdown,
          path: foundRelativeUri.foundInDir
            ? foundRelativeUri.relativePathOrBasename
            : fileUri,
          files: filesInSkillsDirectory,
        });
      } catch (error) {
        errors.push({
          fatal: false,
          message: `Failed to parse markdown skill file: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
  } catch (err) {
    errors.push({
      fatal: false,
      message: `Error loading markdown skill files: ${err instanceof Error ? err.message : err}`,
    });
  }

  return { skills, errors };
}
