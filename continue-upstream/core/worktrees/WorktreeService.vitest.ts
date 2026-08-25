import { exec } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseWorktreePorcelain, WorktreeService } from "./WorktreeService.js";

describe("parseWorktreePorcelain", () => {
  it("parses branches, detached heads, locks, and main worktree state", () => {
    const result = parseWorktreePorcelain(
      [
        "worktree /repo/main",
        "HEAD abcdef123456",
        "branch refs/heads/main",
        "",
        "worktree /repo/feature",
        "HEAD 123456abcdef",
        "detached",
        "locked in use",
        "",
      ].join("\n"),
    );

    expect(result).toEqual([
      expect.objectContaining({
        path: normalize("/repo/main"),
        branch: "main",
        isMain: true,
        detached: false,
      }),
      expect.objectContaining({
        path: normalize("/repo/feature"),
        isMain: false,
        detached: true,
        locked: "in use",
      }),
    ]);
  });
});

describe("WorktreeService safety", () => {
  const root = normalize("/repo/main");
  const ide = {
    getWorkspaceDirs: vi.fn(async () => [pathToFileURL(root).toString()]),
    getGitRootPath: vi.fn(async () => pathToFileURL(root).toString()),
    subprocess: vi.fn(
      async () =>
        [`worktree ${root}\nHEAD abcdef\nbranch refs/heads/main\n`, ""] as [
          string,
          string,
        ],
    ),
  };

  it("rejects unsafe branch names before running Git", async () => {
    const service = new WorktreeService(ide);
    await expect(
      service.create({ branchName: "feature; remove-everything" }),
    ).rejects.toThrow("not a valid Git reference");
    expect(ide.subprocess).not.toHaveBeenCalled();
  });

  it("never removes the main worktree", async () => {
    const service = new WorktreeService(ide);
    await expect(service.remove({ path: root })).rejects.toThrow(
      "main worktree cannot be removed",
    );
  });
});

describe("WorktreeService Git integration", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "lumina-worktree-"));
  const repository = join(sandbox, "repository");

  const run = (command: string, cwd?: string) =>
    new Promise<[string, string]>((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve([stdout, stderr]);
      });
    });

  afterAll(() => {
    if (sandbox.startsWith(tmpdir()) && sandbox.includes("lumina-worktree-")) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("creates, lists, and safely removes a real isolated worktree", async () => {
    await run(`git init ${JSON.stringify(repository)}`);
    await run("git config user.email lumina-tests@example.invalid", repository);
    await run("git config user.name Lumina Tests", repository);
    await run("git commit --allow-empty -m initial", repository);

    const service = new WorktreeService({
      getWorkspaceDirs: async () => [pathToFileURL(repository).toString()],
      getGitRootPath: async () => pathToFileURL(repository).toString(),
      subprocess: run,
    });

    const created = await service.create({ branchName: "feature/real" });
    expect(created.branch).toBe("feature/real");
    expect(existsSync(created.path)).toBe(true);
    expect(
      (await service.list()).some((item) => item.branch === "feature/real"),
    ).toBe(true);

    await service.remove({ path: created.path });
    expect(existsSync(created.path)).toBe(false);
    expect(
      (await service.list()).some((item) => item.branch === "feature/real"),
    ).toBe(false);
  });
});
