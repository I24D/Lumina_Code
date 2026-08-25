import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginCatalogService } from "./PluginCatalogService.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function ide(files: Record<string, string>) {
  return {
    getWorkspaceDirs: vi.fn(async () => ["file:///workspace"]),
    fileExists: vi.fn(
      async (uri: string) => uri === "file:///workspace/.continue/plugins",
    ),
    readFile: vi.fn(async (uri: string) => files[uri]),
  } as any;
}

vi.mock("../indexing/walkDir.js", () => ({
  walkDir: vi.fn(async (_root: string, mockIde: any) =>
    Object.keys(mockIde.__files ?? {}),
  ),
}));

describe("PluginCatalogService", () => {
  it("catalogs data-only plugin skills and persists enable state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-plugins-"));
    roots.push(root);
    const files = {
      "file:///workspace/.continue/plugins/release/plugin.json": JSON.stringify(
        {
          id: "release-pack",
          name: "Release pack",
          version: "1.0.0",
          description: "Release procedures",
        },
      ),
      "file:///workspace/.continue/plugins/release/skills/check/SKILL.md":
        "skill",
    };
    const mockIde = ide(files);
    mockIde.__files = files;
    const catalog = new PluginCatalogService(mockIde, {
      statePath: path.join(root, "state.json"),
    });

    expect(await catalog.list()).toMatchObject([
      {
        id: "release-pack",
        enabled: true,
        skillFiles: [expect.stringContaining("SKILL.md")],
      },
    ]);
    expect(await catalog.setEnabled("release-pack", false)).toMatchObject([
      { id: "release-pack", enabled: false },
    ]);
    expect((await catalog.list())[0].enabled).toBe(false);
  });
});
