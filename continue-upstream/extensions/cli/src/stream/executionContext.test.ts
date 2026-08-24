import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getAgentExecutionContext,
  resolveToolPermissionState,
  resolveAgentPath,
  runWithAgentExecutionContext,
  shouldUseChatHistoryService,
  snapshotToolPermissionState,
} from "./executionContext.js";

describe("agent execution context", () => {
  const permissions = {
    permissions: {
      policies: [
        {
          tool: "Bash",
          permission: "ask",
          argumentMatches: { command: "git status" },
        },
      ],
    },
    currentMode: "normal",
    isHeadless: false,
  } as any;

  it("snapshots delegated permissions without sharing mutable policies", () => {
    const snapshot = snapshotToolPermissionState(permissions);

    permissions.permissions.policies[0].permission = "allow";
    permissions.permissions.policies[0].argumentMatches.command = "*";

    expect(snapshot.permissions.policies[0]).toMatchObject({
      permission: "ask",
      argumentMatches: { command: "git status" },
    });
  });

  it("keeps concurrent request contexts isolated", async () => {
    const observe = (sessionId: string) =>
      runWithAgentExecutionContext(
        {
          sessionId,
          kind: "subagent",
          permissionState: { ...permissions, currentMode: "plan" },
          useChatHistoryService: false,
        },
        async () => {
          await Promise.resolve();
          return {
            sessionId: getAgentExecutionContext()?.sessionId,
            mode: (await resolveToolPermissionState()).currentMode,
            usesGlobalHistory: shouldUseChatHistoryService(),
          };
        },
      );

    expect(await Promise.all([observe("first"), observe("second")])).toEqual([
      { sessionId: "first", mode: "plan", usesGlobalHistory: false },
      { sessionId: "second", mode: "plan", usesGlobalHistory: false },
    ]);
    expect(getAgentExecutionContext()).toBeUndefined();
    expect(shouldUseChatHistoryService()).toBe(true);
  });

  it("resolves relative paths inside a child worktree and blocks escapes", async () => {
    const worktree = path.resolve("isolated-child");
    await runWithAgentExecutionContext(
      {
        sessionId: "child",
        kind: "subagent",
        workingDirectory: worktree,
      },
      async () => {
        expect(resolveAgentPath("src/index.ts")).toBe(
          path.join(worktree, "src", "index.ts"),
        );
        expect(() => resolveAgentPath("../outside.txt")).toThrow(
          "Path escapes the isolated agent worktree",
        );
      },
    );
  });
});
