import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChildSessionRecord } from "./childSession.js";
import {
  applyChildWorktree,
  finalizeChildWorktree,
  permissionsCanWrite,
  prepareChildWorktree,
} from "./worktree.js";

vi.mock("./childSession.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./childSession.js")>();
  return { ...actual, saveChildSession: vi.fn() };
});

describe("delegated Git worktrees", () => {
  let originalCwd: string;
  let repoRoot: string;
  let worktreePath: string | undefined;

  const git = (args: string[], cwd = repoRoot) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  beforeEach(() => {
    originalCwd = process.cwd();
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-worktree-test-"));
    git(["init"]);
    git(["config", "user.name", "Lumina Test"]);
    git(["config", "user.email", "lumina-test@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "base\n", "utf8");
    git(["add", "file.txt"]);
    git(["commit", "-m", "base"]);
    process.chdir(repoRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (worktreePath && fs.existsSync(worktreePath)) {
      git(["worktree", "remove", worktreePath, "--force"]);
    }
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("isolates changes until an explicit reviewed apply", async () => {
    const child = {
      sessionId: "child-1",
      parentSessionId: "parent-1",
      agentName: "code",
      workspaceDirectory: repoRoot,
    } as ChildSessionRecord;

    worktreePath = await prepareChildWorktree(child);
    fs.writeFileSync(path.join(worktreePath, "file.txt"), "changed\n", "utf8");
    finalizeChildWorktree(child);

    expect(fs.readFileSync(path.join(repoRoot, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(child.worktree?.status).toBe("ready");
    expect(path.resolve(child.worktree!.repoRoot)).toBe(path.resolve(repoRoot));
    expect(child.worktree?.diff).toContain("+changed");

    applyChildWorktree(child);
    expect(
      fs
        .readFileSync(path.join(repoRoot, "file.txt"), "utf8")
        .replace(/\r\n/g, "\n"),
    ).toBe("changed\n");
    expect(child.worktree?.status).toBe("applied");
  });

  it("detects whether delegated permissions can write", () => {
    const readOnly = {
      permissions: { policies: [{ tool: "*", permission: "exclude" }] },
      currentMode: "plan",
      isHeadless: false,
    } as any;
    const writeEnabled = {
      ...readOnly,
      permissions: {
        policies: [
          { tool: "Write", permission: "allow" },
          { tool: "*", permission: "exclude" },
        ],
      },
    } as any;
    const terminalEnabled = {
      ...readOnly,
      permissions: {
        policies: [
          { tool: "Bash", permission: "allow" },
          { tool: "*", permission: "exclude" },
        ],
      },
    } as any;

    expect(permissionsCanWrite(readOnly)).toBe(false);
    expect(permissionsCanWrite(writeEnabled)).toBe(true);
    expect(permissionsCanWrite(terminalEnabled)).toBe(true);
  });
});
