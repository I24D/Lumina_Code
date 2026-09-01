import { llmStreamChat } from "../llm/streamChat";
import { ChatDescriber } from "../util/chatDescriber";
import { compactConversation } from "../util/conversationCompaction";
import historyManager from "../util/history";
import { Logger } from "../util/Logger.js";
import { getSymbolsForManyFiles } from "../util/treeSitter";
import { fetchwithRequestOptions } from "@continuedev/fetch";
import { defineHandlers } from "./types.js";

export default defineHandlers("context", (ctx) => {
  const { on } = ctx;

  // Context providers
  on("context/addDocs", async (msg) => {
    void ctx.docsService.indexAndAdd(msg.data);
  });

  on("context/removeDocs", async (msg) => {
    await ctx.docsService.delete(msg.data.startUrl);
  });

  on("context/indexDocs", async (msg) => {
    await ctx.docsService.syncDocsWithPrompt(msg.data.reIndex);
  });

  on("context/loadSubmenuItems", async (msg) => {
    const { config } = await ctx.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    try {
      const items = await config.contextProviders
        ?.find((provider) => provider.description.title === msg.data.title)
        ?.loadSubmenuItems({
          config,
          ide: ctx.ide,
          fetch: (url, init) =>
            fetchwithRequestOptions(url, init, config.requestOptions),
        });
      return items || [];
    } catch (e) {
      Logger.error(e);
      return [];
    }
  });

  on("context/getContextItems", ctx.core.getContextItems);

  on("context/getSymbolsForFiles", async (msg) => {
    const { uris } = msg.data;
    return await getSymbolsForManyFiles(uris, ctx.ide);
  });

  on("config/getSerializedProfileInfo", async (msg) => {
    return {
      result: await ctx.configHandler.getSerializedConfig(),
      profileId:
        ctx.configHandler.currentProfile?.profileDescription.id ?? null,
      profiles: ctx.configHandler.profileDescriptions,
    };
  });

  on("llm/streamChat", (msg) => {
    const abortController = ctx.core.addMessageAbortController(msg.messageId);
    return llmStreamChat(
      ctx.configHandler,
      abortController,
      msg,
      ctx.ide,
      ctx.messenger,
    );
  });

  on("llm/complete", async (msg) => {
    const { config } = await ctx.configHandler.loadConfig();
    const model = config?.selectedModelByRole.chat;
    if (!model) {
      throw new Error("No chat model selected");
    }
    const abortController = ctx.core.addMessageAbortController(msg.messageId);

    const completion = await model.complete(
      msg.data.prompt,
      abortController.signal,
      msg.data.completionOptions,
    );
    return completion;
  });
  on("llm/listModels", ctx.core.handleListModels);

  on("llm/compileChat", async (msg) => {
    const { messages, options } = msg.data;
    const model = (await ctx.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!model) {
      throw new Error("No chat model selected");
    }

    return model.compileChatMessages(messages, options);
  });

  // Provide messenger to utils so they can interact with GUI + state
  ChatDescriber.messenger = ctx.messenger;

  on("chatDescriber/describe", async (msg) => {
    const currentModel = (await ctx.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!currentModel) {
      throw new Error("No chat model selected");
    }

    return await ChatDescriber.describe(currentModel, {}, msg.data.text);
  });

  on("conversation/compact", async (msg) => {
    const currentModel = (await ctx.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!currentModel) {
      throw new Error("No chat model selected");
    }

    // Let protocol errors propagate to the GUI. Swallowing them made
    // `/compact` reload an unchanged conversation and look successful.
    await compactConversation({
      sessionId: msg.data.sessionId,
      index: msg.data.index,
      historyManager,
      currentModel,
    });
    return undefined;
  });
});
