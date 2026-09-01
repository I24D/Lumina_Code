import { walkDirCache } from "../indexing/walkDir";
import { defineHandlers } from "./types.js";

export default defineHandlers("indexing", (ctx) => {
  const { on } = ctx;

  on("index/forceReIndex", async ({ data }) => {
    const { config } = await ctx.configHandler.loadConfig();
    if (!config || config.disableIndexing) {
      return; // TODO silent in case of commands?
    }
    walkDirCache.invalidate();
    if (data?.shouldClearIndexes) {
      await ctx.codeBaseIndexer.clearIndexes();
    }
    const dirs = data?.dirs ?? (await ctx.ide.getWorkspaceDirs());
    await ctx.codeBaseIndexer.refreshCodebaseIndex(dirs);
  });
  on("index/setPaused", (msg) => {
    ctx.globalContext.update("indexingPaused", msg.data);
    // Update using the new setter instead of token
    ctx.codeBaseIndexer.paused = msg.data;
  });
  on("index/indexingProgressBarInitialized", async (msg) => {
    // Triggered when progress bar is initialized.
    // If a non-default state has been stored, update the indexing display to that state
    const currentState = ctx.codeBaseIndexer.currentIndexingState;

    if (currentState.status !== "loading") {
      void ctx.messenger.request("indexProgress", currentState);
    }
  });
});
