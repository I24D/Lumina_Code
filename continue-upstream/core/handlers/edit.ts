import { DevDataSqliteDb } from "../data/devdataSqlite";
import { myersDiff } from "../diff/myers";
import { ApplyAbortManager } from "../edit/applyAbortManager";
import { streamDiffLines } from "../edit/streamDiffLines";
import { luminaAgentRuntime } from "../orchestrator/index.js";
import { defineHandlers } from "./types.js";

export default defineHandlers("edit", (ctx) => {
  const { on } = ctx;

  on("streamDiffLines", async (msg) => {
    const { config } = await ctx.configHandler.loadConfig();
    if (!config) {
      throw new Error("Failed to load config");
    }

    const { data } = msg;

    // Title can be an edit, chat, or apply model
    // Fall back to chat
    const llm =
      config.modelsByRole.edit.find((m) => m.title === data.modelTitle) ??
      config.modelsByRole.apply.find((m) => m.title === data.modelTitle) ??
      config.modelsByRole.chat.find((m) => m.title === data.modelTitle) ??
      config.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No model selected");
    }

    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(
      data.fileUri ?? "current-file-stream",
    ); // not super important since currently cancelling apply will cancel all streams it's one file at a time

    return streamDiffLines(
      data,
      llm,
      abortController,
      undefined,
      data.includeRulesInSystemMessage ? config.rules : undefined,
    );
  });

  on("getDiffLines", (msg) => {
    return myersDiff(msg.data.oldContent, msg.data.newContent);
  });

  on("cancelApply", async (msg) => {
    const abortManager = ApplyAbortManager.getInstance();
    abortManager.clear(); // for now abort all streams
  });

  on("onboarding/complete", ctx.core.handleCompleteOnboarding);

  on("addAutocompleteModel", ctx.core.handleAddAutocompleteModel);

  on("stats/getTokensPerDay", async (msg) => {
    const rows = await DevDataSqliteDb.getTokensPerDay();
    return rows;
  });
  on("stats/getTokensPerModel", async (msg) => {
    const rows = await DevDataSqliteDb.getTokensPerModel();
    return rows;
  });

  on("lumina/assistantState", async () =>
    luminaAgentRuntime.getAssistantState(),
  );

  on(
    "lumina/reportToolResult",
    async ({ data: { toolCall, result, durationMs } }) => {
      luminaAgentRuntime.startToolCall(toolCall);
      luminaAgentRuntime.finishToolCall(toolCall, result, durationMs ?? 0);
    },
  );
});
