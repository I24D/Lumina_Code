import { describe, expect, it, vi } from "vitest";

import { parseMarkdownRule } from "@continuedev/config-yaml";
import {
  renderSkillMarkdown,
  SkillWorkshopService,
} from "./SkillWorkshopService.js";

function ide(overrides: Record<string, unknown> = {}) {
  return {
    getWorkspaceDirs: vi.fn(async () => ["file:///workspace"]),
    fileExists: vi.fn(async () => false),
    writeFile: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("SkillWorkshopService", () => {
  it("quotes frontmatter values that contain YAML punctuation", () => {
    const markdown = renderSkillMarkdown({
      name: "Deploy: production #1",
      description: "Use when: a release contains #hotfix",
      content: "## When to Use\n\nRun after tests pass.",
      scope: "workspace",
    });
    const parsed = parseMarkdownRule(markdown) as any;
    expect(parsed.frontmatter).toMatchObject({
      name: "Deploy: production #1",
      description: "Use when: a release contains #hotfix",
    });
  });

  it("uses the same linter before writing from the workshop", async () => {
    const mockIde = ide();
    const workshop = new SkillWorkshopService(mockIde);
    await expect(
      workshop.save({
        name: "",
        description: "",
        content: "",
        scope: "workspace",
      }),
    ).rejects.toThrow(/validación/i);
    expect(mockIde.writeFile).not.toHaveBeenCalled();
  });

  it("writes workspace skills and refuses an implicit overwrite", async () => {
    const mockIde = ide();
    const workshop = new SkillWorkshopService(mockIde);
    await workshop.save({
      name: "Release checklist",
      description: "Use before publishing a release",
      content: "## When to Use\n\n1. Run tests.\n2. Build.",
      scope: "workspace",
    });
    expect(mockIde.writeFile.mock.calls[0][0]).toContain(
      ".continue/skills/release-checklist/SKILL.md",
    );

    mockIde.fileExists.mockResolvedValue(true);
    await expect(
      workshop.save({
        name: "Release checklist",
        description: "Use before publishing a release",
        content: "## When to Use\n\nUpdated.",
        scope: "workspace",
      }),
    ).rejects.toThrow(/reemplazar/i);
  });
});
