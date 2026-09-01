import { defineHandlers } from "./types.js";

export default defineHandlers("docs", (ctx) => {
  const { on } = ctx;

  // Docs, etc. indexing
  on("indexing/reindex", async (msg) => {
    if (msg.data.type === "docs") {
      void ctx.docsService.reindexDoc(msg.data.id);
    }
  });
  on("indexing/abort", async (msg) => {
    if (msg.data.type === "docs") {
      ctx.docsService.abort(msg.data.id);
    }
  });
  on("indexing/setPaused", async (msg) => {
    if (msg.data.type === "docs") {
    }
  });
  on("docs/initStatuses", async (msg) => {
    void ctx.docsService.initStatuses();
  });
  on("docs/getDetails", async (msg) => {
    return await ctx.docsService.getDetails(msg.data.startUrl);
  });
  on("docs/getIndexedPages", async (msg) => {
    const pages = await ctx.docsService.getIndexedPages(msg.data.startUrl);
    return Array.from(pages);
  });

  on("didChangeSelectedProfile", async (msg) => {
    if (msg.data.id) {
      await ctx.configHandler.setSelectedProfileId(msg.data.id);
    }
  });

  on("auth/getAuthUrl", async (_msg) => {
    return { url: "" };
  });
});
