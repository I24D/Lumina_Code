import { getTodoStore } from "../planner/TodoStore.js";
import historyManager from "../util/history";
import { shareSession } from "../util/historyUtils";
import { WorktreeService } from "../worktrees/WorktreeService.js";
import { pathToFileURL } from "node:url";
import { defineHandlers } from "./types.js";

/** Sessions, their history, and the worktrees a session can be forked into. */
export default defineHandlers("session", (ctx) => {
  const { on } = ctx;
  const worktreeService = new WorktreeService(ctx.ide);

  on("abort", (msg) => {
    ctx.core.abortById(msg.data ?? msg.messageId);
  });

  on("ping", (msg) => {
    if (msg.data !== "ping") {
      throw new Error("ping message incorrect");
    }
    return "pong";
  });

  // History
  on("history/list", async (msg) => {
    const sessions = historyManager.list(msg.data);
    const limit = msg.data?.limit ?? 100;
    return sessions.slice(0, limit);
  });

  on("history/delete", (msg) => {
    historyManager.delete(msg.data.id);
  });

  on("history/load", (msg) => {
    // The working task list belongs to one conversation. These two handlers
    // are the only place core learns which conversation is in front of the
    // user, so they are where the list follows along.
    getTodoStore().setActiveSession(msg.data.id);
    return historyManager.load(msg.data.id);
  });

  on("history/save", (msg) => {
    getTodoStore().setActiveSession(msg.data.sessionId);
    historyManager.save(msg.data);
  });

  on("history/share", async (msg) => {
    const session = historyManager.load(msg.data.id);
    const outputDir = msg.data.outputDir;
    const history = session.history.map((msg) => msg.message);
    await shareSession(ctx.ide, history, outputDir);
  });

  on("history/clear", (msg) => {
    historyManager.clearAll();
  });

  on("sessions/fork", (msg) => {
    const forked = historyManager.fork(msg.data.sessionId, {
      historyIndex: msg.data.historyIndex,
      title: msg.data.title,
    });
    getTodoStore().setActiveSession(forked.sessionId);
    return forked;
  });

  on("sessions/forkToWorktree", async (msg) => {
    const worktree = await worktreeService.getRegistered(msg.data.worktreePath);
    const forked = historyManager.fork(msg.data.sessionId, {
      historyIndex: msg.data.historyIndex,
      title: msg.data.title,
      workspaceDirectory: pathToFileURL(worktree.path).toString(),
      worktreePath: worktree.path,
    });
    return forked;
  });

  on("worktrees/list", (msg) =>
    worktreeService.list(msg.data?.workspaceDirectory),
  );

  on("worktrees/create", (msg) => worktreeService.create(msg.data));

  on("worktrees/remove", (msg) => worktreeService.remove(msg.data));
});
