import { Position } from "../index.js";
import {
  openedFilesLruCache,
  prevFilepaths,
} from "../autocomplete/util/openedFilesLruCache";
import {
  isColocatedRulesFile,
  isContinueAgentConfigFile,
  isContinueConfigRelatedUri,
} from "../config/loadLocalAssistants";
import { CodebaseRulesCache } from "../config/markdown/loadCodebaseRules";
import { shouldIgnore } from "../indexing/shouldIgnore";
import { walkDirCache } from "../indexing/walkDir";
import { EditAggregator } from "../nextEdit/context/aggregateEdits";
import { BeforeAfterDiff } from "../nextEdit/context/diffFormatting";
import { processSmallEdit } from "../nextEdit/context/processSmallEdit";
import { NextEditProvider } from "../nextEdit/NextEditProvider";
import { Logger } from "../util/Logger.js";
import { defineHandlers } from "./types.js";

export default defineHandlers("files", (ctx) => {
  const { on } = ctx;

  // File changes - TODO - remove remaining logic for these from IDEs where possible
  on("files/changed", ctx.core.handleFilesChanged);
  const refreshIfNotIgnored = async (uris: string[]) => {
    const toRefresh: string[] = [];
    for (const uri of uris) {
      const ignore = await shouldIgnore(uri, ctx.ide);
      if (!ignore) {
        toRefresh.push(uri);
      }
    }
    if (toRefresh.length > 0) {
      ctx.messenger.send("refreshSubmenuItems", {
        providers: ["file"],
      });
      const { config } = await ctx.configHandler.loadConfig();
      if (config && !config.disableIndexing) {
        await ctx.codeBaseIndexer.refreshCodebaseIndexFiles(toRefresh);
      }
    }
  };

  on("files/created", async ({ data }) => {
    if (!data?.uris?.length) {
      return;
    }

    walkDirCache.invalidate();
    void refreshIfNotIgnored(data.uris);

    const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
    const nonColocatedRuleUris = data.uris.filter(
      (uri) => !isColocatedRulesFile(uri),
    );
    if (colocatedRulesUris) {
      const rulesCache = CodebaseRulesCache.getInstance();
      void Promise.all(
        colocatedRulesUris.map((uri) => rulesCache.update(ctx.ide, uri)),
      ).then(() => {
        void ctx.configHandler.reloadConfig("Codebase rule file created");
      });
    }

    // If it's a local config being created, we want to reload all configs so it shows up in the list
    if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
      await ctx.configHandler.refreshAll("Local config file created");
    } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
      await ctx.configHandler.reloadConfig(
        ".continue config-related file created",
      );
    }
  });

  on("files/deleted", async ({ data }) => {
    if (!data?.uris?.length) {
      return;
    }

    walkDirCache.invalidate();
    void refreshIfNotIgnored(data.uris);

    const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
    const nonColocatedRuleUris = data.uris.filter(
      (uri) => !isColocatedRulesFile(uri),
    );

    if (colocatedRulesUris) {
      const rulesCache = CodebaseRulesCache.getInstance();
      void Promise.all(
        colocatedRulesUris.map((uri) => rulesCache.remove(uri)),
      ).then(() => {
        void ctx.configHandler.reloadConfig("Codebase rule file deleted");
      });
    }

    // If it's a local config being deleted, we want to reload all configs so it disappears from the list
    if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
      await ctx.configHandler.refreshAll("Local config file deleted");
    } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
      await ctx.configHandler.reloadConfig(
        ".continue config-related file deleted",
      );
    }
  });

  on("files/closed", async ({ data }) => {
    console.debug("deleteChain called from files/closed");
    await NextEditProvider.getInstance().deleteChain();

    try {
      const fileUris = await ctx.ide.getOpenFiles();
      if (fileUris) {
        const filepaths = fileUris.map((uri) => uri.toString());

        if (!prevFilepaths.filepaths.length) {
          prevFilepaths.filepaths = filepaths;
        }

        // If there is a removal, including if the number of tabs is the same (which can happen with temp tabs)
        if (filepaths.length <= prevFilepaths.filepaths.length) {
          // Remove files from cache that are no longer open (i.e. in the cache but not in the list of opened tabs)
          for (const [key, _] of openedFilesLruCache.entriesDescending()) {
            if (!filepaths.includes(key)) {
              openedFilesLruCache.delete(key);
            }
          }
        }
        prevFilepaths.filepaths = filepaths;
      }
    } catch (e) {
      Logger.error(
        `didChangeVisibleTextEditors: failed to update openedFilesLruCache`,
      );
    }

    if (data.uris) {
      ctx.messenger.send("didCloseFiles", {
        uris: data.uris,
      });
    }
  });

  on("files/opened", async ({ data: { uris } }) => {
    if (uris) {
      for (const filepath of uris) {
        try {
          const ignore = await shouldIgnore(filepath, ctx.ide);
          if (!ignore) {
            // Set the active file as most recently used (need to force recency update by deleting and re-adding)
            if (openedFilesLruCache.has(filepath)) {
              openedFilesLruCache.delete(filepath);
            }
            openedFilesLruCache.set(filepath, filepath);
          }
        } catch (e) {
          Logger.error(
            `files/opened: failed to update openedFiles cache for ${filepath}`,
          );
        }
      }
    }
  });

  on("files/smallEdit", async ({ data }) => {
    const EDIT_AGGREGATION_OPTIONS = {
      deltaT: 1.0,
      deltaL: 5,
      maxEdits: 500,
      maxDuration: 120.0,
      contextSize: 5,
    };

    EditAggregator.getInstance(
      EDIT_AGGREGATION_OPTIONS,
      (
        beforeAfterdiff: BeforeAfterDiff,
        cursorPosBeforeEdit: Position,
        cursorPosAfterPrevEdit: Position,
      ) => {
        void processSmallEdit(
          beforeAfterdiff,
          cursorPosBeforeEdit,
          cursorPosAfterPrevEdit,
          data.configHandler,
          data.getDefsFromLspFunction,
          ctx.ide,
        );
      },
    );

    const workspaceDir =
      data.actions.length > 0 ? data.actions[0].workspaceDir : undefined;

    // Store the latest context data
    const instance = EditAggregator.getInstance();
    (instance as any).latestContextData = {
      configHandler: data.configHandler,
      getDefsFromLspFunction: data.getDefsFromLspFunction,
      recentlyEditedRanges: data.recentlyEditedRanges,
      recentlyVisitedRanges: data.recentlyVisitedRanges,
      workspaceDir: workspaceDir,
    };

    // queueMicrotask prevents blocking the UI thread during typing
    queueMicrotask(() => {
      void EditAggregator.getInstance().processEdits(data.actions);
    });
  });
});
