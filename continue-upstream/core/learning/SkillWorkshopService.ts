import type { IDE, Skill } from "../index.js";
import { getGlobalFolderWithName } from "../util/paths.js";
import { localPathToUri } from "../util/pathToUri.js";
import { joinPathsToUri } from "../util/uri.js";
import {
  hasBlockingFinding,
  lintSkill,
  type SkillLintInput,
} from "./SkillLinter.js";
import { getSkillUsageStore } from "./SkillUsageStore.js";
import type { SkillLintFinding, SkillProvenance } from "./types.js";

export type SkillScope = "global" | "workspace";

export interface SkillDraft {
  name: string;
  description: string;
  content: string;
  scope: SkillScope;
}

export interface SkillSaveResult {
  skill: Skill;
  findings: SkillLintFinding[];
  created: boolean;
}

export function skillSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug || "skill";
}

export function renderSkillMarkdown(draft: SkillDraft): string {
  const safeName = draft.name.replace(/\r?\n/gu, " ").trim();
  const safeDescription = draft.description.replace(/\r?\n/gu, " ").trim();
  // JSON string literals are valid YAML scalars and correctly escape colons,
  // hashes, quotes and other characters that previously broke frontmatter.
  return [
    "---",
    `name: ${JSON.stringify(safeName)}`,
    `description: ${JSON.stringify(safeDescription)}`,
    "---",
    "",
    draft.content.trim(),
    "",
  ].join("\n");
}

export class SkillWorkshopService {
  constructor(private readonly ide: IDE) {}

  lint(draft: SkillDraft): SkillLintFinding[] {
    const input: SkillLintInput = {
      name: draft.name,
      description: draft.description,
      content: draft.content,
      slug: skillSlug(draft.name),
    };
    return lintSkill(input);
  }

  async save(
    draft: SkillDraft,
    options: { overwrite?: boolean; provenance?: SkillProvenance } = {},
  ): Promise<SkillSaveResult> {
    const findings = this.lint(draft);
    if (hasBlockingFinding(findings)) {
      const error = new Error("La habilidad no supera la validación.");
      Object.assign(error, { findings });
      throw error;
    }

    const slug = skillSlug(draft.name);
    const directory = await this.resolveDirectory(draft.scope, slug);
    const path = joinPathsToUri(directory, "SKILL.md");
    const exists = await this.ide.fileExists(path);
    if (exists && options.overwrite !== true) {
      throw new Error(
        `Skill "${slug}" already exists. Activa reemplazar para editarla.`,
      );
    }

    const markdown = renderSkillMarkdown(draft);
    await this.ide.writeFile(path, markdown);
    const name = draft.name.replace(/\r?\n/gu, " ").trim();
    const description = draft.description.replace(/\r?\n/gu, " ").trim();
    const usage = getSkillUsageStore();
    if (exists) usage.recordPatch(name);
    else usage.recordCreate(name, options.provenance ?? "user");

    return {
      created: !exists,
      findings,
      skill: {
        name,
        description,
        content: draft.content.trim(),
        path,
        files: [],
      },
    };
  }

  private async resolveDirectory(
    scope: SkillScope,
    slug: string,
  ): Promise<string> {
    if (scope === "workspace") {
      const dirs = await this.ide.getWorkspaceDirs();
      if (dirs.length === 0) {
        throw new Error(
          "No hay un workspace abierto. Usa el alcance global para guardar la habilidad.",
        );
      }
      return joinPathsToUri(dirs[0], ".continue", "skills", slug);
    }
    return joinPathsToUri(
      localPathToUri(getGlobalFolderWithName("skills")),
      slug,
    );
  }
}
