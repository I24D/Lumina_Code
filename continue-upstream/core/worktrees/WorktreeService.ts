import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { IDE } from "../index.js";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
  isMain: boolean;
  isDirty?: boolean;
}

export interface CreateWorktreeRequest {
  branchName: string;
  baseRef?: string;
  workspaceDirectory?: string;
}

export interface RemoveWorktreeRequest {
  path: string;
  force?: boolean;
  workspaceDirectory?: string;
}

function localPath(value: string): string {
  if (value.startsWith("file:")) {
    return fileURLToPath(value);
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizeCase = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return (
    normalizeCase(resolve(localPath(left))) ===
    normalizeCase(resolve(localPath(right)))
  );
}

function quoteShellArgument(value: string): string {
  if (process.platform === "win32") {
    if (value.includes('"')) {
      throw new Error("Git paths containing quotation marks are not supported");
    }
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertSafeGitRef(value: string, label: string): string {
  const ref = value.trim();
  const invalid =
    ref.length === 0 ||
    ref.startsWith("-") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.includes("\\") ||
    /[\s~^:?*[\]]/.test(ref) ||
    !/^[A-Za-z0-9._/-]+$/.test(ref);
  if (invalid) {
    throw new Error(`${label} is not a valid Git reference`);
  }
  return ref;
}

function worktreeDirectoryName(branchName: string): string {
  const name = branchName
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!name) {
    throw new Error("The branch name cannot be converted to a directory name");
  }
  return name;
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const records = output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter(Boolean);

  return records
    .map((record, index) => {
      const info: WorktreeInfo = {
        path: "",
        head: "",
        bare: false,
        detached: false,
        isMain: index === 0,
      };
      for (const line of record.split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);
        switch (key) {
          case "worktree":
            info.path = normalize(value);
            break;
          case "HEAD":
            info.head = value;
            break;
          case "branch":
            info.branch = value.replace(/^refs\/heads\//, "");
            break;
          case "bare":
            info.bare = true;
            break;
          case "detached":
            info.detached = true;
            break;
          case "locked":
            info.locked = value || "locked";
            break;
          case "prunable":
            info.prunable = value || "prunable";
            break;
        }
      }
      return info;
    })
    .filter((record) => record.path.length > 0);
}

export class WorktreeService {
  constructor(
    private readonly ide: Pick<
      IDE,
      "getWorkspaceDirs" | "getGitRootPath" | "subprocess"
    >,
  ) {}

  private async workspaceUri(requested?: string): Promise<string> {
    const workspaces = await this.ide.getWorkspaceDirs();
    if (workspaces.length === 0) {
      throw new Error("Open a Git workspace before managing worktrees");
    }
    if (!requested) {
      return workspaces[0];
    }
    const match = workspaces.find((workspace) =>
      samePath(workspace, requested),
    );
    if (!match) {
      throw new Error("The requested directory is not an open workspace");
    }
    return match;
  }

  private async repositoryRoot(requested?: string): Promise<string> {
    const workspace = await this.workspaceUri(requested);
    const root = await this.ide.getGitRootPath(workspace);
    if (!root) {
      throw new Error("The active workspace is not inside a Git repository");
    }
    return localPath(root);
  }

  private async run(command: string, cwd: string): Promise<string> {
    try {
      const [stdout, stderr] = await this.ide.subprocess(command, cwd);
      if (stderr.trim() && !stdout.trim()) {
        throw new Error(stderr.trim());
      }
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.trim() || `Git command failed: ${command}`);
    }
  }

  private async listFromRoot(root: string): Promise<WorktreeInfo[]> {
    const output = await this.run(
      "git -c core.quotePath=false worktree list --porcelain",
      root,
    );
    const worktrees = parseWorktreePorcelain(output);
    await Promise.all(
      worktrees.map(async (worktree) => {
        if (worktree.bare || !existsSync(worktree.path)) {
          return;
        }
        try {
          const status = await this.run(
            "git status --porcelain",
            worktree.path,
          );
          worktree.isDirty = status.trim().length > 0;
        } catch {
          worktree.isDirty = undefined;
        }
      }),
    );
    return worktrees;
  }

  async list(workspaceDirectory?: string): Promise<WorktreeInfo[]> {
    return this.listFromRoot(await this.repositoryRoot(workspaceDirectory));
  }

  async create(request: CreateWorktreeRequest): Promise<WorktreeInfo> {
    const branchName = assertSafeGitRef(request.branchName, "Branch name");
    const baseRef = assertSafeGitRef(
      request.baseRef ?? "HEAD",
      "Base reference",
    );
    const repositoryRoot = await this.repositoryRoot(
      request.workspaceDirectory,
    );
    const current = await this.listFromRoot(repositoryRoot);
    const mainPath =
      current.find((worktree) => worktree.isMain)?.path ?? repositoryRoot;
    const container = `${mainPath}-worktrees`;
    const targetPath = join(container, worktreeDirectoryName(branchName));

    if (existsSync(targetPath)) {
      throw new Error(`Worktree directory already exists: ${targetPath}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    await this.run(
      `git worktree add -b ${quoteShellArgument(branchName)} ${quoteShellArgument(targetPath)} ${quoteShellArgument(baseRef)}`,
      repositoryRoot,
    );

    const created = (await this.listFromRoot(repositoryRoot)).find((worktree) =>
      samePath(worktree.path, targetPath),
    );
    if (!created) {
      throw new Error("Git created the worktree but it could not be listed");
    }
    return created;
  }

  async remove(request: RemoveWorktreeRequest): Promise<void> {
    const repositoryRoot = await this.repositoryRoot(
      request.workspaceDirectory,
    );
    const worktrees = await this.listFromRoot(repositoryRoot);
    const target = worktrees.find((worktree) =>
      samePath(worktree.path, request.path),
    );
    if (!target) {
      throw new Error("The requested path is not a registered worktree");
    }
    if (target.isMain) {
      throw new Error("The main worktree cannot be removed");
    }
    if (target.locked) {
      throw new Error(
        `Unlock the worktree before removing it: ${target.locked}`,
      );
    }
    const force = request.force ? " --force" : "";
    await this.run(
      `git worktree remove${force} ${quoteShellArgument(target.path)}`,
      repositoryRoot,
    );
  }
}
