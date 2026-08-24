import { execFileSync } from "node:child_process";

import {
  captureWorktreeDiff,
  createWorktree,
} from "../commands/review/worktree.js";
import { checkToolPermission } from "../permissions/permissionChecker.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";

import {
  type ChildSessionRecord,
  loadChildSession,
  saveChildSession,
} from "./childSession.js";

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "Bash"] as const;

export function permissionsCanWrite(
  permissionState: ToolPermissionServiceState,
): boolean {
  return WRITE_TOOLS.some(
    (name) =>
      checkToolPermission({ name, arguments: {} }, permissionState.permissions)
        .permission !== "exclude",
  );
}

export async function prepareChildWorktree(
  child: ChildSessionRecord,
): Promise<string> {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!repoRoot) throw new Error("Unable to determine the Git repository root");

  const worktreePath = await createWorktree(
    Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    repoRoot,
  );
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  child.worktree = {
    path: worktreePath,
    repoRoot,
    baseCommit,
    status: "active",
  };
  child.workspaceDirectory = worktreePath;
  saveChildSession(child);
  return worktreePath;
}

export function finalizeChildWorktree(child: ChildSessionRecord): void {
  if (!child.worktree) return;
  try {
    const diff = captureWorktreeDiff(child.worktree.path);
    child.worktree.diff = diff;
    child.worktree.status = diff.trim() ? "ready" : "unchanged";
  } catch (error) {
    child.worktree.status = "failed";
    child.worktree.error =
      error instanceof Error ? error.message : String(error);
  }
  saveChildSession(child);
}

export function getChildWorktreeDiff(child: ChildSessionRecord): string {
  if (!child.worktree) return "";
  const diff = captureWorktreeDiff(child.worktree.path);
  child.worktree.diff = diff;
  saveChildSession(child);
  return diff;
}

/** Apply reviewed child changes to the user's tree. Never called automatically. */
export function applyChildWorktree(child: ChildSessionRecord): string {
  if (!child.worktree)
    throw new Error("Child session has no isolated worktree");
  if (child.worktree.status === "applied") {
    throw new Error("Child worktree was already applied");
  }
  const diff = getChildWorktreeDiff(child);
  if (!diff.trim()) {
    child.worktree.status = "unchanged";
    saveChildSession(child);
    return "";
  }

  const runApply = (checkOnly: boolean) =>
    execFileSync("git", ["apply", ...(checkOnly ? ["--check"] : []), "-"], {
      cwd: child.worktree!.repoRoot,
      input: diff,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  runApply(true);
  runApply(false);
  child.worktree.status = "applied";
  saveChildSession(child);
  return diff;
}

export function getChildWorktreeReview(
  sessionId: string,
): { diff: string; status: string } | null {
  const child = loadChildSession(sessionId);
  if (!child?.worktree) return null;
  return {
    diff: getChildWorktreeDiff(child),
    status: child.worktree.status,
  };
}

export function applyChildWorktreeById(
  sessionId: string,
): { applied: true; diff: string } | null {
  const child = loadChildSession(sessionId);
  if (!child?.worktree) return null;
  return { applied: true, diff: applyChildWorktree(child) };
}
