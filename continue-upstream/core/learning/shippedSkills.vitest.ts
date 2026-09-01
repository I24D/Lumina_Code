import { parseMarkdownRule } from "@continuedev/config-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lintSkill, SKILL_INDEX_DESCRIPTION_LIMIT } from "./SkillLinter.js";
import { skillSlug } from "./SkillWorkshopService.js";

/**
 * Las skills que se envían con Lumina Code se cargan en silencio: si una tiene
 * el frontmatter mal, `loadMarkdownSkills` empuja el error a una lista que nadie
 * lee y la skill simplemente no aparece en el índice. Esta prueba es el bucle de
 * validación que lo convierte en un fallo visible.
 *
 * La biblioteca vive dentro del producto, en `extensions/vscode/skills`, porque
 * es lo único que acaba dentro del VSIX. Una carpeta fuera de ese árbol solo
 * funciona en la máquina donde el repositorio es el workspace abierto.
 */
const productRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const skillsDir = path.join(productRoot, "extensions", "vscode", "skills");

function shippedSkillFiles(): string[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, "SKILL.md"))
    .filter((file) => fs.existsSync(file));
}

const files = shippedSkillFiles();

describe("shipped skills", () => {
  it("finds the bundled skill library", () => {
    // Si esto falla, el directorio se movió: el cargador tampoco lo encuentra y
    // el VSIX se empaqueta sin skills.
    expect(fs.existsSync(skillsDir)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it("every skill parses and passes the linter", () => {
    const problems: string[] = [];

    for (const file of files) {
      const relative = path.relative(productRoot, file).replace(/\\/gu, "/");
      const raw = fs.readFileSync(file, "utf8");

      const { frontmatter, markdown } = parseMarkdownRule(raw) as unknown as {
        frontmatter: { name?: string; description?: string };
        markdown: string;
      };

      const name = frontmatter?.name ?? "";
      const description = frontmatter?.description ?? "";

      // El cargador nombra la carpeta a partir del slug, así que un desajuste
      // deja la skill accesible con un nombre que nadie va a adivinar.
      const directory = path.basename(path.dirname(file));
      if (name !== directory) {
        problems.push(
          `${relative}: name "${name}" does not match its directory "${directory}"`,
        );
      }

      if (description.length > SKILL_INDEX_DESCRIPTION_LIMIT) {
        problems.push(
          `${relative}: description is ${description.length} chars, index truncates at ${SKILL_INDEX_DESCRIPTION_LIMIT}`,
        );
      }

      for (const finding of lintSkill({
        name,
        description,
        content: markdown,
        slug: skillSlug(name),
      })) {
        problems.push(
          `${relative}: [${finding.severity}] ${finding.rule}: ${finding.message}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
