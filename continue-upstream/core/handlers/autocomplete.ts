import { PrefetchQueue } from "../nextEdit/NextEditPrefetchQueue";
import { NextEditProvider } from "../nextEdit/NextEditProvider";
import { defineHandlers } from "./types.js";

export default defineHandlers("autocomplete", (ctx) => {
  const { on } = ctx;

  // Autocomplete
  on("autocomplete/complete", async (msg) => {
    const outcome = await ctx.completionProvider.provideInlineCompletionItems(
      msg.data,
      undefined,
    );
    return outcome ? [outcome.completion] : [];
  });
  on("autocomplete/accept", async (msg) => {
    ctx.completionProvider.accept(msg.data.completionId);
  });
  on("autocomplete/cancel", async (msg) => {
    ctx.completionProvider.cancel();
  });

  // Next Edit
  on("nextEdit/predict", async (msg) => {
    const outcome = await ctx.nextEditProvider.provideInlineCompletionItems(
      msg.data.input,
      undefined,
      {
        withChain: msg.data.options?.withChain ?? false,
        usingFullFileDiff: msg.data.options?.usingFullFileDiff ?? true,
      },
    );
    return outcome;
    // ? [outcome.completion, outcome.originalEditableRange]
  });
  on("nextEdit/accept", async (msg) => {
    console.log("nextEdit/accept");
    ctx.nextEditProvider.accept(msg.data.completionId);
  });
  on("nextEdit/reject", async (msg) => {
    console.log("nextEdit/reject");
    ctx.nextEditProvider.reject(msg.data.completionId);
  });
  on("nextEdit/startChain", async (msg) => {
    console.log("nextEdit/startChain");
    NextEditProvider.getInstance().startChain();
    return;
  });

  on("nextEdit/deleteChain", async (msg) => {
    console.log("nextEdit/deleteChain");
    await NextEditProvider.getInstance().deleteChain();
    return;
  });

  on("nextEdit/isChainAlive", async (msg) => {
    console.log("nextEdit/isChainAlive");
    return NextEditProvider.getInstance().chainExists();
  });

  on("nextEdit/queue/getProcessedCount", async (msg) => {
    console.log("nextEdit/queue/getProcessedCount");
    const queue = PrefetchQueue.getInstance();
    console.log(queue.processedCount);
    return queue.processedCount;
  });

  on("nextEdit/queue/dequeueProcessed", async (msg) => {
    console.log("nextEdit/queue/dequeueProcessed");
    const queue = PrefetchQueue.getInstance();
    return queue.dequeueProcessed() || null;
  });

  // NOTE: This is not used unless prefetch is used.
  // At this point this is not used because I opted to rely on the model to return multiple diffs than to use prefetching.
  on("nextEdit/queue/processOne", async (msg) => {
    console.log("nextEdit/queue/processOne");
    const { ctx, recentlyVisitedRanges, recentlyEditedRanges } = msg.data;
    const queue = PrefetchQueue.getInstance();

    await queue.process({
      ...ctx,
      recentlyVisitedRanges,
      recentlyEditedRanges,
    });
    return;
  });

  on("nextEdit/queue/clear", async (msg) => {
    console.log("nextEdit/queue/clear");
    const queue = PrefetchQueue.getInstance();
    queue.clear();
    return;
  });

  on("nextEdit/queue/abort", async (msg) => {
    console.log("nextEdit/queue/abort");
    const queue = PrefetchQueue.getInstance();
    queue.abort();
    return;
  });
});
