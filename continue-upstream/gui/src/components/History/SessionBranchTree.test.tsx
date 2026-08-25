import { screen } from "@testing-library/react";
import type { BaseSessionMetadata } from "core";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { buildSessionTree, SessionBranchTree } from "./SessionBranchTree";

const sessions: BaseSessionMetadata[] = [
  {
    sessionId: "root",
    title: "Original investigation",
    dateCreated: "2026-08-25T10:00:00.000Z",
    workspaceDirectory: "file:///repo",
    messageCount: 2,
  },
  {
    sessionId: "fork-a",
    parentSessionId: "root",
    parentHistoryIndex: 1,
    title: "Try parser fix",
    dateCreated: "2026-08-25T11:00:00.000Z",
    workspaceDirectory: "file:///repo",
    messageCount: 4,
  },
  {
    sessionId: "fork-b",
    parentSessionId: "fork-a",
    parentHistoryIndex: 3,
    title: "Try safer parser fix",
    dateCreated: "2026-08-25T12:00:00.000Z",
    workspaceDirectory: "file:///repo-worktrees/parser",
    messageCount: 1,
  },
];

describe("SessionBranchTree", () => {
  it("builds nested conversation lineage", () => {
    const roots = buildSessionTree(sessions);
    expect(roots).toHaveLength(1);
    expect(roots[0].session.sessionId).toBe("root");
    expect(roots[0].children[0].session.sessionId).toBe("fork-a");
    expect(roots[0].children[0].children[0].session.sessionId).toBe("fork-b");
  });

  it("breaks corrupt lineage cycles instead of recursing forever", () => {
    const cyclic = sessions.slice(0, 2).map((session) => ({ ...session }));
    cyclic[0].parentSessionId = "fork-a";
    expect(buildSessionTree(cyclic)).toHaveLength(2);
  });

  it("opens the selected branch", async () => {
    const onOpen = vi.fn();
    const { user } = await renderWithProviders(
      <SessionBranchTree sessions={sessions} onOpen={onOpen} />,
    );
    await user.click(screen.getByRole("button", { name: /try parser fix/i }));
    expect(onOpen).toHaveBeenCalledWith("fork-a");
  });
});
