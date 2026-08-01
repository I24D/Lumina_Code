import { parseMarkdownRule } from "@continuedev/config-yaml";
import { expect, test, vi } from "vitest";

import { ToolExtras } from "../..";
import { luminaCreateSkillImpl } from "./luminaCreateSkill";

function makeExtras(opts: { exists?: boolean } = {}) {
  const writes: Array<{ uri: string; content: string }> = [];
  const ide = {
    getWorkspaceDirs: vi.fn().mockResolvedValue(["file:///workspace"]),
    fileExists: vi.fn().mockResolvedValue(opts.exists ?? false),
    writeFile: vi.fn().mockImplementation(async (uri: string, content: string) => {
      writes.push({ uri, content });
    }),
  };
  const extras = { ide } as unknown as ToolExtras;
  return { extras, ide, writes };
}

test("create_skill writes a SKILL.md that read_skill's parser can load", async () => {
  const { extras, writes } = makeExtras();

  const result = await luminaCreateSkillImpl(
    {
      name: "Deploy to Render",
      description: "Steps to deploy this service and verify health",
      content: "1. Push to main.\n2. Render auto-builds.\n3. Check /health returns 200.",
      scope: "workspace",
    },
    extras,
  );

  // Wrote exactly one file in the correct skills location.
  expect(writes).toHaveLength(1);
  expect(writes[0].uri).toContain(".continue/skills/deploy-to-render/SKILL.md");

  // The written content round-trips through the SAME parser loadMarkdownSkills
  // (read_skill) uses — proving the create→recall loop actually works.
  const { frontmatter, markdown } = parseMarkdownRule(writes[0].content) as unknown as {
    frontmatter: { name: string; description: string };
    markdown: string;
  };
  expect(frontmatter.name).toBe("Deploy to Render");
  expect(frontmatter.description).toBe("Steps to deploy this service and verify health");
  expect(markdown).toContain("Render auto-builds");

  // Tool result points the model back to read_skill.
  expect(result[0].content).toContain("read_skill");
});

test("create_skill refuses to overwrite unless overwrite=true", async () => {
  const { extras } = makeExtras({ exists: true });
  await expect(
    luminaCreateSkillImpl(
      { name: "Existing", description: "d", content: "c", scope: "workspace" },
      extras,
    ),
  ).rejects.toThrow(/already exists/u);
});

test("create_skill overwrites when overwrite=true", async () => {
  const { extras, writes } = makeExtras({ exists: true });
  await luminaCreateSkillImpl(
    { name: "Existing", description: "d", content: "c", scope: "workspace", overwrite: true },
    extras,
  );
  expect(writes).toHaveLength(1);
});
