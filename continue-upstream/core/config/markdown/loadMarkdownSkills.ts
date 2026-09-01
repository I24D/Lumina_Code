import {
  ConfigValidationError,
  parseMarkdownRule,
} from "@continuedev/config-yaml";
import z from "zod";
import { IDE, Skill } from "../..";
import { walkDir } from "../../indexing/walkDir";
import { readLuminaEnv } from "../../luminaBridge/luminaEnv";
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
 * Parsed SKILL.md bodies, keyed by URI and invalidated by mtime.
 *
 * `loadMarkdownSkills` runs on every config reload — a saved config file, a
 * changed rule, a toggled plugin, an MCP refresh — and each run re-read and
 * re-parsed every skill from disk. The frontmatter is what feeds the skill
 * index in the system prompt, so this is on the path of every agent request.
 *
 * Only the read and parse are cached. The sibling-file listing still goes
 * through `walkDir`, which has its own cache and is invalidated when any file
 * in the workspace changes; caching it here on SKILL.md's mtime would go stale
 * whenever a skill's supporting file changed without SKILL.md being touched.
 */
const parsedSkillCache = new Map<
  string,
  { lastModified: number; frontmatter: Skill; markdown: string }
>();

/** Exposed for tests; also lets a caller force a cold read. */
export function clearMarkdownSkillCache(): void {
  parsedSkillCache.clear();
}

/**
 * Extra skill libraries outside the workspace/global .continue and .claude
 * folders, provided as absolute paths in the LUMINA_SKILLS_DIR var
 * (comma-separated). This lets Lumina Code reuse a shared skill library
 * (SKILL.md format) without copying files.
 * Unset → no extra dirs → behaviour unchanged.
 *
 * Se lee con `readLuminaEnv`, no con `process.env` a secas: el `.env` de la
 * raíz se parsea a una caché propia y NUNCA se inyecta en el entorno del
 * proceso, así que un `LUMINA_SKILLS_DIR=` puesto ahí quedaba mudo. `process.env`
 * sigue teniendo prioridad dentro de `readLuminaEnv`, así que exportarla a mano
 * sigue funcionando igual.
 */
async function getLuminaExtraSkillFiles(ide: IDE): Promise<string[]> {
  const raw = readLuminaEnv("LUMINA_SKILLS_DIR") ?? "";
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
 * La biblioteca de skills que viaja dentro de la extensión.
 *
 * Todos los demás orígenes de este módulo son locales a la máquina: una carpeta
 * del workspace abierto, otra en el home del usuario, o una variable de entorno.
 * Ninguno viaja con el VSIX, así que una Lumina Code instalada arrancaba con la
 * biblioteca vacía: las skills solo aparecían en la máquina donde el repositorio
 * resultaba ser la carpeta abierta.
 *
 * La ruta la aporta el anfitrión; no es configuración del usuario. Deducirla
 * subiendo desde la ubicación de este módulo funciona en el árbol del
 * repositorio y se rompe en cuanto el bundle vive en `~/.vscode/extensions`
 * —exactamente como se perdió en su día el `.env` de la raíz (ver
 * `extensions/vscode/src/extension/luminaRoot.ts`).
 */
async function getBundledSkillFiles(ide: IDE): Promise<string[]> {
  const localPath = process.env.LUMINA_BUNDLED_SKILLS_DIR?.trim();
  if (!localPath) {
    return [];
  }
  const dir = localPathToUri(localPath);
  if (!(await ide.fileExists(dir))) {
    return [];
  }
  const uris = await walkDir(dir, ide, {
    source: "get bundled skills files",
  });
  return uris.filter((uri) => uri.endsWith(".md"));
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
      // Al final a propósito: `read_skill` resuelve un nombre por la PRIMERA
      // coincidencia, así que una skill escrita por el usuario tapa a la que
      // trae la extensión, y no al revés.
      ...(await getBundledSkillFiles(ide)),
    ];

    const skillFiles = yamlAndMarkdownFileUris.filter((path) =>
      path.endsWith("SKILL.md"),
    );

    const workspaceDirs = await ide.getWorkspaceDirs();

    // One round trip for every skill, so an unchanged library costs no reads.
    let stats: Awaited<ReturnType<IDE["getFileStats"]>> = {};
    if (skillFiles.length > 0) {
      try {
        stats = await ide.getFileStats(skillFiles);
      } catch {
        // No stats means no cache hits, not a failure to load.
      }
    }

    const seen = new Set<string>();
    // Nombres ya reclamados. Dos skills con el mismo nombre gastan sitio en el
    // índice y dejan sin decidir cuál abre `read_skill`; gana la primera, que
    // por el orden de los orígenes es siempre la más cercana al usuario.
    const claimed = new Set<string>();
    for (const fileUri of skillFiles) {
      seen.add(fileUri);
      try {
        const lastModified = stats[fileUri]?.lastModified;
        const cached = parsedSkillCache.get(fileUri);

        let frontmatter: Skill;
        let markdown: string;
        if (
          cached !== undefined &&
          lastModified !== undefined &&
          cached.lastModified === lastModified
        ) {
          ({ frontmatter, markdown } = cached);
        } else {
          const content = await ide.readFile(fileUri);
          ({ frontmatter, markdown } = parseMarkdownRule(
            content,
          ) as unknown as { frontmatter: Skill; markdown: string });
          if (lastModified !== undefined) {
            parsedSkillCache.set(fileUri, {
              lastModified,
              frontmatter,
              markdown,
            });
          }
        }

        const validatedFrontmatter = skillFrontmatterSchema.parse(frontmatter);

        if (claimed.has(validatedFrontmatter.name)) {
          continue;
        }
        claimed.add(validatedFrontmatter.name);

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

    // Drop skills that no longer exist so a deleted or renamed library can't
    // keep the cache growing for the life of the process.
    for (const uri of parsedSkillCache.keys()) {
      if (!seen.has(uri)) {
        parsedSkillCache.delete(uri);
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
