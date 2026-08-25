import type { Session } from "core";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { Worktrees } from "./Worktrees";

describe("Worktrees", () => {
  it("shows the Git worktrees and opens one in a new window", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["worktrees/list"] = [
      {
        path: "C:\\repo",
        head: "abcdef123456",
        branch: "main",
        bare: false,
        detached: false,
        isMain: true,
        isDirty: false,
      },
      {
        path: "C:\\repo-worktrees\\feature-chat",
        head: "123456abcdef",
        branch: "feature/chat",
        bare: false,
        detached: false,
        isMain: false,
        isDirty: true,
      },
    ];
    const post = vi.spyOn(messenger, "post");

    const { user } = await renderWithProviders(<Worktrees />, {
      mockIdeMessenger: messenger,
    });

    expect(await screen.findByText("feature/chat")).toBeInTheDocument();
    expect(screen.getByText("con cambios")).toBeInTheDocument();
    const openButtons = screen.getAllByRole("button", { name: /abrir/i });
    await user.click(openButtons[1]);
    expect(post).toHaveBeenCalledWith("worktrees/open", {
      path: "C:\\repo-worktrees\\feature-chat",
    });
  });

  it("creates a worktree from the selected base reference", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["worktrees/list"] = [];
    const create = vi.fn().mockResolvedValue({
      path: "C:\\repo-worktrees\\feature-sessions",
      head: "abcdef123456",
      branch: "feature/sessions",
      bare: false,
      detached: false,
      isMain: false,
      isDirty: false,
    });
    messenger.responseHandlers["worktrees/create"] = create;

    const { user } = await renderWithProviders(<Worktrees />, {
      mockIdeMessenger: messenger,
    });
    await user.type(screen.getByLabelText("Nueva rama"), "feature/sessions");
    await user.clear(screen.getByLabelText("Crear desde"));
    await user.type(screen.getByLabelText("Crear desde"), "main");
    await user.click(screen.getByRole("button", { name: "Crear worktree" }));

    expect(create).toHaveBeenCalledWith({
      branchName: "feature/sessions",
      baseRef: "main",
    });
    expect(await screen.findByText("feature/sessions")).toBeInTheDocument();
  });

  it("forks the active chat into a worktree and hands it to the new window", async () => {
    const messenger = new MockIdeMessenger();
    const worktree = {
      path: "C:\\repo-worktrees\\feature-chat",
      head: "123456abcdef",
      branch: "feature/chat",
      bare: false,
      detached: false,
      isMain: false,
      isDirty: false,
    };
    const activeSession: Session = {
      sessionId: "active-session",
      title: "Current work",
      workspaceDirectory: "file:///C:/repo",
      history: [
        {
          message: { role: "user", content: "Continue in isolation" },
          contextItems: [],
        },
      ],
    };
    const forkedSession: Session = {
      ...activeSession,
      sessionId: "worktree-session",
      parentSessionId: activeSession.sessionId,
      workspaceDirectory: "file:///C:/repo-worktrees/feature-chat",
      worktreePath: worktree.path,
    };
    messenger.responses["worktrees/list"] = [worktree];
    messenger.responses["history/load"] = activeSession;
    const fork = vi.fn().mockResolvedValue(forkedSession);
    messenger.responseHandlers["sessions/forkToWorktree"] = fork;
    const post = vi.spyOn(messenger, "post");
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(newSession(activeSession));

    const { user } = await renderWithProviders(<Worktrees />, {
      mockIdeMessenger: messenger,
      store,
    });
    await user.click(await screen.findByRole("button", { name: /sesión/i }));

    expect(fork).toHaveBeenCalledWith({
      sessionId: activeSession.sessionId,
      worktreePath: worktree.path,
      historyIndex: undefined,
      title: undefined,
    });
    expect(post).toHaveBeenCalledWith("worktrees/open", {
      path: worktree.path,
      sessionId: forkedSession.sessionId,
    });
  });
});
