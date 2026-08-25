import { fetchwithRequestOptions } from "@continuedev/fetch";
import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import * as URI from "uri-js";
import { v4 as uuidv4 } from "uuid";

import { CompletionProvider } from "./autocomplete/CompletionProvider";
import {
  openedFilesLruCache,
  prevFilepaths,
} from "./autocomplete/util/openedFilesLruCache";
import { ConfigHandler } from "./config/ConfigHandler";
import { addModel, deleteModel } from "./config/util";
import { DevDataSqliteDb } from "./data/devdataSqlite";
import { DataLogger } from "./data/log";
import { GitHubWorkItemService } from "./integrations/GitHubWorkItemService.js";
import { CodebaseIndexer } from "./indexing/CodebaseIndexer";
import DocsService from "./indexing/docs/DocsService";
import { countTokens } from "./llm/countTokens";
import Lemonade from "./llm/llms/Lemonade";
import { fetchModels } from "./llm/fetchModels";
import Ollama from "./llm/llms/Ollama";
import { EditAggregator } from "./nextEdit/context/aggregateEdits";
import { createNewPromptFileV2 } from "./promptFiles/createNewPromptFile";
import { callTool } from "./tools/callTool";
import { ChatDescriber } from "./util/chatDescriber";
import { compactConversation } from "./util/conversationCompaction";
import { GlobalContext } from "./util/GlobalContext";
import { resolveWorkspaceEnvValue } from "./util/workspaceEnv.js";
import historyManager from "./util/history";
import {
  editConfigFile,
  getContinueGlobalPath,
  migrateV1DevDataFiles,
} from "./util/paths";

import {
  isProcessBackgrounded,
  killTerminalProcess,
  markProcessAsBackgrounded,
} from "./util/processTerminalStates";
import { getSymbolsForManyFiles } from "./util/treeSitter";

import {
  CompleteOnboardingPayload,
  ContextItemId,
  ContextItemWithId,
  IdeSettings,
  ModelDescription,
  Position,
  RangeInFile,
  ToolCall,
  type ContextItem,
  type IDE,
} from ".";

import { ConfigYaml } from "@continuedev/config-yaml";
import { getDiffFn, GitDiffCache } from "./autocomplete/snippets/gitDiffCache";
import { stringifyMcpPrompt } from "./commands/slash/mcpSlashCommand";
import { createNewAssistantFile } from "./config/createNewAssistantFile";
import {
  isColocatedRulesFile,
  isContinueAgentConfigFile,
  isContinueConfigRelatedUri,
} from "./config/loadLocalAssistants";
import { CodebaseRulesCache } from "./config/markdown/loadCodebaseRules";
import { loadMarkdownSkills } from "./config/markdown/loadMarkdownSkills";
import { getSessionSearchIndex } from "./learning/SessionSearchIndex.js";
import { getSkillUsageStore } from "./learning/SkillUsageStore.js";
import { getTodoStore } from "./planner/TodoStore.js";
import {
  setupLocalConfig,
  setupProviderConfig,
  setupQuickstartConfig,
} from "./config/onboarding";
import {
  createNewGlobalRuleFile,
  createNewWorkspaceBlockFile,
} from "./config/workspace/workspaceBlocks";
import { MCPManagerSingleton } from "./context/mcp/MCPManagerSingleton";
import { performAuth, removeMCPAuth } from "./context/mcp/MCPOauth";
import { myersDiff } from "./diff/myers";
import { ApplyAbortManager } from "./edit/applyAbortManager";
import { streamDiffLines } from "./edit/streamDiffLines";
import { shouldIgnore } from "./indexing/shouldIgnore";
import { walkDirCache } from "./indexing/walkDir";
import { LLMLogger } from "./llm/logger";
import { llmStreamChat } from "./llm/streamChat";
import { BeforeAfterDiff } from "./nextEdit/context/diffFormatting";
import { processSmallEdit } from "./nextEdit/context/processSmallEdit";
import { PrefetchQueue } from "./nextEdit/NextEditPrefetchQueue";
import { NextEditProvider } from "./nextEdit/NextEditProvider";
import { luminaAgentRuntime } from "./orchestrator/index.js";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import { OnboardingModes, type SkillWithUsage } from "./protocol/core";
import type { IMessenger, Message } from "./protocol/messenger";
import {
  resolveStartTalkGeminiEnv,
  selectStartTalkGeminiEnv,
  type StartTalkConfigStatus,
  type StartTalkConfigUpdate,
  type StartTalkGeminiConfigStore,
} from "./startTalk/env.js";
import { clearGoal, getGoal, listGoals, setGoal } from "./goals/goalStore.js";
import {
  applyVerdict,
  createGoal,
  parseGoalVerdict,
} from "./goals/sessionGoal.js";
import {
  CAPABILITIES,
  getPermissions,
  resetPermissions,
  setPermission,
} from "./privacy/permissions.js";
import { StartTalkManager } from "./startTalk/index.js";
import { ScheduledTaskService } from "./scheduler/ScheduledTaskService.js";
import {
  WhatsAppAutoResponder,
  type AutoReplyAuditEntry,
} from "./startTalk/WhatsAppAutoResponder.js";
import { ContinueError, ContinueErrorReason } from "./util/errors";
import { shareSession } from "./util/historyUtils";
import { Logger } from "./util/Logger.js";

export class Core {
  configHandler: ConfigHandler;
  codeBaseIndexer: CodebaseIndexer;
  completionProvider: CompletionProvider;
  nextEditProvider: NextEditProvider;
  private docsService: DocsService;
  private whatsappAutoResponder?: WhatsAppAutoResponder;
  private globalContext = new GlobalContext();
  private startTalkManager: StartTalkManager;
  private scheduledTaskService: ScheduledTaskService;
  llmLogger = new LLMLogger();

  private messageAbortControllers = new Map<string, AbortController>();
  private addMessageAbortController(id: string): AbortController {
    const controller = new AbortController();
    this.messageAbortControllers.set(id, controller);
    controller.signal.addEventListener("abort", () => {
      this.messageAbortControllers.delete(id);
    });
    return controller;
  }
  private abortById(messageId: string) {
    this.messageAbortControllers.get(messageId)?.abort();
  }

  invoke<T extends keyof ToCoreProtocol>(
    messageType: T,
    data: ToCoreProtocol[T][0],
  ): ToCoreProtocol[T][1] {
    return this.messenger.invoke(messageType, data);
  }

  send<T extends keyof FromCoreProtocol>(
    messageType: T,
    data: FromCoreProtocol[T][0],
    messageId?: string,
  ): string {
    return this.messenger.send(messageType, data, messageId);
  }

  // TODO: It shouldn't actually need an IDE type, because this can happen
  // through the messenger (it does in the case of any non-VS Code IDEs already)
  constructor(
    private readonly messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
    private readonly ide: IDE,
    private readonly startTalkConfigStore?: StartTalkGeminiConfigStore,
  ) {
    try {
      // Ensure .continue directory is created
      migrateV1DevDataFiles();

      const ideInfoPromise = messenger.request("getIdeInfo", undefined);
      const ideSettingsPromise = messenger.request("getIdeSettings", undefined);
      this.configHandler = new ConfigHandler(this.ide, this.llmLogger);
      this.startTalkManager = new StartTalkManager((event) => {
        this.messenger.send("startTalk/event", event);
      });
      this.scheduledTaskService = new ScheduledTaskService();

      // Autonomous WhatsApp assistant: watches incoming WhatsApp notifications
      // (Desktop + Enlace móvil), drafts a reply with the chat model and sends it
      // for DIRECT chats only — never groups. Owner is always informed (audit).
      this.whatsappAutoResponder = this.createWhatsAppAutoResponder();
      this.whatsappAutoResponder?.start();

      this.docsService = DocsService.createSingleton(
        this.configHandler,
        this.ide,
        this.messenger,
      );

      MCPManagerSingleton.getInstance().onConnectionsRefreshed = () => {
        void this.configHandler.reloadConfig("MCP Connections refreshed");

        // Refresh @mention dropdown submenu items for MCP providers
        const mcpManager = MCPManagerSingleton.getInstance();
        const mcpProviderNames = Array.from(mcpManager.connections.keys()).map(
          (mcpId) => `mcp-${mcpId}`,
        );

        if (mcpProviderNames.length > 0) {
          this.messenger.send("refreshSubmenuItems", {
            providers: mcpProviderNames,
          });
        }
      };

      this.codeBaseIndexer = new CodebaseIndexer(
        this.configHandler,
        this.ide,
        this.messenger,
        this.globalContext.get("indexingPaused"),
      );

      this.configHandler.onConfigUpdate((result) => {
        void (async () => {
          const serializedResult =
            await this.configHandler.getSerializedConfig();
          this.messenger.send("configUpdate", {
            result: serializedResult,
            profileId:
              this.configHandler.currentProfile?.profileDescription.id || null,
            profiles: this.configHandler.profileDescriptions,
          });

          if (await this.codeBaseIndexer.wasAnyOneIndexAdded()) {
            await this.codeBaseIndexer.refreshCodebaseIndex(
              await this.ide.getWorkspaceDirs(),
            );
          }

          // update additional submenu context providers registered via VSCode API
          const additionalProviders =
            this.configHandler.getAdditionalSubmenuContextProviders();
          if (additionalProviders.length > 0) {
            this.messenger.send("refreshSubmenuItems", {
              providers: additionalProviders,
            });
          }
        })();
      });

      // Dev Data Logger
      const dataLogger = DataLogger.getInstance();
      dataLogger.core = this;
      dataLogger.ideInfoPromise = ideInfoPromise;
      dataLogger.ideSettingsPromise = ideSettingsPromise;

      void ideSettingsPromise.then((ideSettings) => {
        // Index on initialization
        void this.ide.getWorkspaceDirs().then(async (dirs) => {
          // Respect pauseCodebaseIndexOnStart user settings
          if (ideSettings.pauseCodebaseIndexOnStart) {
            this.codeBaseIndexer.paused = true;
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Initial Indexing Skipped",
              status: "paused",
            });
            return;
          }

          // Check for disableIndexing to prevent race condition
          const { config } = await this.configHandler.loadConfig();
          if (!config || config.disableIndexing) {
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Indexing is disabled",
              status: "disabled",
            });
            return;
          }

          void this.codeBaseIndexer.refreshCodebaseIndex(dirs);
        });
      });

      const getLlm = async () => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          return undefined;
        }
        return config.selectedModelByRole.autocomplete ?? undefined;
      };
      this.completionProvider = new CompletionProvider(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
      );

      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      void codebaseRulesCache
        .refresh(ide)
        .catch((e) =>
          Logger.error("Failed to initialize colocated rules cache"),
        )
        .then(() => {
          void this.configHandler.reloadConfig(
            "Initial codebase rules post-walkdir/load reload",
          );
        });
      this.nextEditProvider = NextEditProvider.initialize(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
        "fineTuned",
      );

      this.registerMessageHandlers(ideSettingsPromise);
    } catch (error) {
      Logger.error(error);
      throw error; // Re-throw to prevent partially initialized core
    }
  }

  /* eslint-disable max-lines-per-function */
  private registerMessageHandlers(ideSettingsPromise: Promise<IdeSettings>) {
    const on = this.messenger.on.bind(this.messenger);

    // Note, VsCode's in-process messenger doesn't do anything with this
    // It will only show for jetbrains
    this.messenger.onError((message, err) => {
      // just to prevent duplicate error messages in jetbrains (same logic in webview protocol)
      if (
        ["llm/streamChat", "chatDescriber/describe"].includes(
          message.messageType,
        )
      ) {
        return;
      } else {
        void this.ide.showToast("error", err.message);
      }
    });

    on("abort", (msg) => {
      this.abortById(msg.data ?? msg.messageId);
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
      await shareSession(this.ide, history, outputDir);
    });

    on("history/clear", (msg) => {
      historyManager.clearAll();
    });

    // Memory — procedural (skills) and episodic (past sessions)
    on("skills/list", async () => {
      return await this.listSkillsWithUsage();
    });

    on("skills/curate", async (msg) => {
      const store = getSkillUsageStore();
      const { name, action } = msg.data;
      switch (action) {
        case "archive":
          store.setArchived(name, true);
          break;
        case "unarchive":
          store.setArchived(name, false);
          break;
        case "pin":
          store.setPinned(name, true);
          break;
        case "unpin":
          store.setPinned(name, false);
          break;
      }
      // Returning the fresh list saves the settings page a second round trip
      // and guarantees it renders what was actually persisted.
      return await this.listSkillsWithUsage();
    });

    on("todos/list", async () => {
      return getTodoStore().read();
    });

    on("sessions/search", async (msg) => {
      const index = getSessionSearchIndex();
      const { query, limit, currentWorkspaceOnly } = msg.data;

      let workspaceDirectory: string | undefined;
      if (currentWorkspaceOnly) {
        workspaceDirectory = (await this.ide.getWorkspaceDirs())[0];
      }

      try {
        await index.refresh();
      } catch {
        // Stale results beat no results; the index is still queryable.
      }

      if (!query || query.trim() === "") {
        return {
          hits: [],
          recent: await index.browse(limit ?? 20, workspaceDirectory),
        };
      }
      return {
        hits: await index.search({
          query: query.trim(),
          limit,
          workspaceDirectory,
        }),
        recent: [],
      };
    });

    on("devdata/log", async (msg) => {
      void DataLogger.getInstance().logDevData(msg.data);
    });

    on("config/addModel", async (msg) => {
      const model = msg.data.model;
      const { config } = await this.configHandler.loadConfig();
      const allModels = Object.values(config?.modelsByRole ?? {}).flat();
      const existing = allModels.find(
        (m) => m.providerName === model.provider && m.model === model.model,
      );
      if (existing) {
        void this.ide.showToast(
          "warning",
          "Model already exists in config. Update the API key in the config file.",
        );
        await this.configHandler.openConfigProfile();
        return;
      }
      addModel(model, msg.data.role);
      void this.configHandler.reloadConfig(
        "Model added (config/addModel message)",
      );
    });

    on("config/deleteModel", (msg) => {
      deleteModel(msg.data.title);
      void this.configHandler.reloadConfig(
        "Model removed (config/deleteModel message)",
      );
    });

    on("config/newPromptFile", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      await createNewPromptFileV2(this.ide, config?.experimental?.promptPath);
      await this.configHandler.reloadConfig(
        "Prompt file created (config/newPromptFile message)",
      );
    });

    on("config/newAssistantFile", async (msg) => {
      await createNewAssistantFile(this.ide, undefined);
      await this.configHandler.refreshAll(
        "Assistant file created (config/newAssistantFile message)",
      );
    });

    on("config/addLocalWorkspaceBlock", async (msg) => {
      await createNewWorkspaceBlockFile(
        this.ide,
        msg.data.blockType,
        msg.data.baseFilename,
      );
      walkDirCache.invalidate();
      await this.configHandler.reloadConfig(
        "Local block created (config/addLocalWorkspaceBlock message)",
      );
    });

    on("config/addGlobalRule", async (msg) => {
      try {
        await createNewGlobalRuleFile(this.ide, msg.data?.baseFilename);
        walkDirCache.invalidate();
        await this.configHandler.reloadConfig(
          "Global rule created (config/addGlobalRule message)",
        );
      } catch (error) {
        throw error;
      }
    });

    on("config/deleteRule", async (msg) => {
      try {
        const filepath = msg.data.filepath;
        if (
          !isColocatedRulesFile(filepath) &&
          !isContinueConfigRelatedUri(filepath)
        ) {
          throw new Error("Only rule files can be deleted");
        }
        const fileExists = await this.ide.fileExists(filepath);
        if (fileExists) {
          await this.ide.removeFile(filepath);
          walkDirCache.invalidate();
          await this.configHandler.reloadConfig(
            "Rule file deleted (config/deleteRule message)",
          );
        }
      } catch (error) {
        console.error("Failed to delete rule file:", error);
        throw error;
      }
    });

    on("config/openProfile", async (msg) => {
      await this.configHandler.openConfigProfile(msg.data.profileId);
    });

    on("config/ideSettingsUpdate", async (msg) => {
      await this.configHandler.updateIdeSettings(msg.data);
    });

    on("config/refreshProfiles", async (msg) => {
      // User force reloading will retrigger colocated rules
      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      await codebaseRulesCache.refresh(this.ide);

      const { selectProfileId, reason } = msg.data ?? {};
      await this.configHandler.refreshAll(reason);
      if (selectProfileId) {
        await this.configHandler.setSelectedProfileId(selectProfileId);
      }
    });

    on("config/updateSharedConfig", async (msg) => {
      const newSharedConfig = this.globalContext.updateSharedConfig(msg.data);
      await this.configHandler.reloadConfig(
        "Shared config update (config/updateSharedConfig message)",
      );
      return newSharedConfig;
    });

    on("config/updateSelectedModel", async (msg) => {
      const newSelectedModels = this.globalContext.updateSelectedModel(
        msg.data.profileId,
        msg.data.role,
        msg.data.title,
      );
      await this.configHandler.reloadConfig(
        "Selected model update (config/updateSelectedModel message)",
      );
      return newSelectedModels;
    });

    on("mcp/reloadServer", async (msg) => {
      await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
    });
    on("mcp/setServerEnabled", async (msg) => {
      const { id, enabled } = msg.data;
      await MCPManagerSingleton.getInstance().setEnabled(id, enabled);
    });
    on("mcp/getPrompt", async (msg) => {
      const { serverName, promptName, args } = msg.data;
      const prompt = await MCPManagerSingleton.getInstance().getPrompt(
        serverName,
        promptName,
        args,
      );
      const stringifiedPrompt = stringifyMcpPrompt(prompt);
      return {
        prompt: stringifiedPrompt,
        description: prompt.description,
      };
    });
    on("mcp/startAuthentication", async (msg) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      MCPManagerSingleton.getInstance().setStatus(
        msg.data.serverId,
        "authenticating",
      );
      const status = await performAuth(
        msg.data.serverId,
        msg.data.serverUrl,
        this.ide,
      );
      if (status === "AUTHORIZED") {
        await MCPManagerSingleton.getInstance().refreshConnection(
          msg.data.serverId,
        );
      }
    });
    on("mcp/removeAuthentication", async (msg) => {
      removeMCPAuth(msg.data.serverUrl, this.ide);
      await MCPManagerSingleton.getInstance().refreshConnection(
        msg.data.serverId,
      );
    });

    // Context providers
    on("context/addDocs", async (msg) => {
      void this.docsService.indexAndAdd(msg.data);
    });

    on("context/removeDocs", async (msg) => {
      await this.docsService.delete(msg.data.startUrl);
    });

    on("context/indexDocs", async (msg) => {
      await this.docsService.syncDocsWithPrompt(msg.data.reIndex);
    });

    on("context/loadSubmenuItems", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        return [];
      }

      try {
        const items = await config.contextProviders
          ?.find((provider) => provider.description.title === msg.data.title)
          ?.loadSubmenuItems({
            config,
            ide: this.ide,
            fetch: (url, init) =>
              fetchwithRequestOptions(url, init, config.requestOptions),
          });
        return items || [];
      } catch (e) {
        Logger.error(e);
        return [];
      }
    });

    on("context/getContextItems", this.getContextItems.bind(this));

    on("context/getSymbolsForFiles", async (msg) => {
      const { uris } = msg.data;
      return await getSymbolsForManyFiles(uris, this.ide);
    });

    on("config/getSerializedProfileInfo", async (msg) => {
      return {
        result: await this.configHandler.getSerializedConfig(),
        profileId:
          this.configHandler.currentProfile?.profileDescription.id ?? null,
        profiles: this.configHandler.profileDescriptions,
      };
    });

    on("llm/streamChat", (msg) => {
      const abortController = this.addMessageAbortController(msg.messageId);
      return llmStreamChat(
        this.configHandler,
        abortController,
        msg,
        this.ide,
        this.messenger,
      );
    });

    on("llm/complete", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      const model = config?.selectedModelByRole.chat;
      if (!model) {
        throw new Error("No chat model selected");
      }
      const abortController = this.addMessageAbortController(msg.messageId);

      const completion = await model.complete(
        msg.data.prompt,
        abortController.signal,
        msg.data.completionOptions,
      );
      return completion;
    });
    on("llm/listModels", this.handleListModels.bind(this));

    on("llm/compileChat", async (msg) => {
      const { messages, options } = msg.data;
      const model = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!model) {
        throw new Error("No chat model selected");
      }

      return model.compileChatMessages(messages, options);
    });

    // Provide messenger to utils so they can interact with GUI + state
    ChatDescriber.messenger = this.messenger;

    on("chatDescriber/describe", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      return await ChatDescriber.describe(currentModel, {}, msg.data.text);
    });

    on("conversation/compact", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
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

    // Autocomplete
    on("autocomplete/complete", async (msg) => {
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          msg.data,
          undefined,
        );
      return outcome ? [outcome.completion] : [];
    });
    on("autocomplete/accept", async (msg) => {
      this.completionProvider.accept(msg.data.completionId);
    });
    on("autocomplete/cancel", async (msg) => {
      this.completionProvider.cancel();
    });

    // Next Edit
    on("nextEdit/predict", async (msg) => {
      const outcome = await this.nextEditProvider.provideInlineCompletionItems(
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
      this.nextEditProvider.accept(msg.data.completionId);
    });
    on("nextEdit/reject", async (msg) => {
      console.log("nextEdit/reject");
      this.nextEditProvider.reject(msg.data.completionId);
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

    on("streamDiffLines", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
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

    on("onboarding/complete", this.handleCompleteOnboarding.bind(this));

    on("addAutocompleteModel", this.handleAddAutocompleteModel.bind(this));

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

    on("startTalk/connect", async (msg) => {
      const { apiKey, model, thinkingLevel, voiceName } =
        await this.getStartTalkGeminiConfig(msg.data.preferredModel);
      return this.startTalkManager.connect({
        apiKey,
        model,
        thinkingLevel: msg.data.thinkingLevel ?? thinkingLevel,
        voiceName,
        languageCode: msg.data.languageCode,
        enableSearch: msg.data.enableSearch,
        enableTools: msg.data.enableTools,
        enableSessionResumption: msg.data.enableSessionResumption,
        mode: msg.data.mode,
        translation: msg.data.translation,
        voiceStyle: msg.data.voiceStyle,
        announceNotifications: msg.data.announceNotifications,
      });
    });

    on("startTalk/getConfigStatus", async () =>
      this.getStartTalkConfigStatus(),
    );

    on("startTalk/configure", async (msg) => {
      await this.configureStartTalk(msg.data);
      return this.getStartTalkConfigStatus();
    });

    on("startTalk/sendAudio", async (msg) => {
      this.startTalkManager.sendAudio(msg.data);
    });

    on("startTalk/sendText", async (msg) => {
      this.startTalkManager.sendText(msg.data);
    });

    on("startTalk/startCapture", async (msg) => {
      this.startTalkManager.startCapture(msg.data);
    });

    on("startTalk/setMuted", async (msg) => {
      this.startTalkManager.setMuted(msg.data);
    });

    on("startTalk/setNotificationAnnouncements", async (msg) => {
      this.startTalkManager.setNotificationAnnouncements(msg.data);
    });

    on("startTalk/getTranscript", async (msg) => {
      return this.startTalkManager.getTranscript(msg.data);
    });

    // Voice delegation relays: forward the orb's task to the sidebar chat, and
    // the sidebar's final answer back to the orb. Core is a pure relay here;
    // the orb and sidebar coordinate by requestId.
    on("startTalk/delegateToMain", async (msg) => {
      const authorization = evaluateSurfaceAuthorization({
        surface: "start-talk",
        capability: "delegate-agent",
        userApproved: msg.data.userApproved === true,
        policy: "allow",
      });
      if (!authorization.authorized) {
        this.messenger.send("startTalk/mainResultReady", {
          requestId: msg.data.requestId,
          text: "Solicitud cancelada: se requiere autorizacion explicita del usuario.",
          error: true,
        });
        return;
      }
      this.messenger.send("startTalk/runInMain", {
        requestId: msg.data.requestId,
        task: msg.data.task,
        context: msg.data.context,
        userApproved: true,
      });
    });

    on("startTalk/mainResult", async (msg) => {
      this.messenger.send("startTalk/mainResultReady", msg.data);
    });

    on("startTalk/endAudio", async (msg) => {
      this.startTalkManager.endAudio(msg.data);
    });

    on("startTalk/stop", async (msg) => {
      this.startTalkManager.stop(msg.data);
    });

    on("startTalk/sendToolResponse", async (msg) => {
      this.startTalkManager.sendToolResponse(msg.data);
    });

    on("startTalk/startVideo", async (msg) => {
      this.startTalkManager.startVideo(msg.data);
    });

    on("startTalk/stopVideo", async (msg) => {
      this.startTalkManager.stopVideo(msg.data);
    });

    on("startTalk/sendVideoFrame", async (msg) => {
      this.startTalkManager.sendVideoFrame(msg.data);
    });

    on("startTalk/listVideoSources", async () => {
      return this.startTalkManager.listVideoSources();
    });

    on("startTalk/reportPlayback", async (msg) => {
      this.startTalkManager.reportPlayback(msg.data);
    });

    on("privacy/getPermissions", async () => ({
      capabilities: CAPABILITIES,
      permissions: getPermissions(),
    }));

    on("privacy/setPermission", async (msg) =>
      setPermission(msg.data.capability, msg.data.policy),
    );

    on("privacy/resetPermissions", async () => resetPermissions());

    on("goals/get", async (msg) => getGoal(msg.data.sessionId));

    on("goals/list", async () => listGoals());

    on("goals/set", async (msg) =>
      setGoal(createGoal(msg.data.sessionId, msg.data.text, msg.data.maxTurns)),
    );

    // El juicio del turno lo hace el cliente con el modelo de chat; aquí solo
    // se parsea de forma defensiva y se aplica el techo de turnos, que es la
    // parte que no puede quedar en manos de la respuesta de un modelo.
    on("goals/applyVerdict", async (msg) => {
      const goal = getGoal(msg.data.sessionId);
      if (!goal) {
        return undefined;
      }
      return setGoal(applyVerdict(goal, parseGoalVerdict(msg.data.raw)));
    });

    on("goals/clear", async (msg) => {
      clearGoal(msg.data.sessionId);
    });

    on("github/getWorkItem", async (msg) => {
      const workspaceDirs = await this.ide.getWorkspaceDirs();
      const token = resolveWorkspaceEnvValue(workspaceDirs, [
        "GITHUB_TOKEN",
        "I24D_GITHUB",
        "LUMINA_PC_GITHUB_TOKEN",
      ]);
      return new GitHubWorkItemService(token).get(msg.data.reference);
    });

    on("scheduler/list", async () => this.scheduledTaskService.list());
    on("scheduler/create", async (msg) =>
      this.scheduledTaskService.create(msg.data),
    );
    on("scheduler/update", async (msg) =>
      this.scheduledTaskService.update(msg.data.id, msg.data.patch),
    );
    on("scheduler/delete", async (msg) => {
      this.scheduledTaskService.remove(msg.data.id);
    });
    on("scheduler/runNow", async (msg) =>
      this.scheduledTaskService.runNow(msg.data.id),
    );
    on("scheduler/claimDue", async () => this.scheduledTaskService.claimDue());
    on("scheduler/reportRun", async (msg) => {
      this.scheduledTaskService.reportRun(msg.data);
    });

    on("index/forceReIndex", async ({ data }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config || config.disableIndexing) {
        return; // TODO silent in case of commands?
      }
      walkDirCache.invalidate();
      if (data?.shouldClearIndexes) {
        await this.codeBaseIndexer.clearIndexes();
      }
      const dirs = data?.dirs ?? (await this.ide.getWorkspaceDirs());
      await this.codeBaseIndexer.refreshCodebaseIndex(dirs);
    });
    on("index/setPaused", (msg) => {
      this.globalContext.update("indexingPaused", msg.data);
      // Update using the new setter instead of token
      this.codeBaseIndexer.paused = msg.data;
    });
    on("index/indexingProgressBarInitialized", async (msg) => {
      // Triggered when progress bar is initialized.
      // If a non-default state has been stored, update the indexing display to that state
      const currentState = this.codeBaseIndexer.currentIndexingState;

      if (currentState.status !== "loading") {
        void this.messenger.request("indexProgress", currentState);
      }
    });

    // File changes - TODO - remove remaining logic for these from IDEs where possible
    on("files/changed", this.handleFilesChanged.bind(this));
    const refreshIfNotIgnored = async (uris: string[]) => {
      const toRefresh: string[] = [];
      for (const uri of uris) {
        const ignore = await shouldIgnore(uri, this.ide);
        if (!ignore) {
          toRefresh.push(uri);
        }
      }
      if (toRefresh.length > 0) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["file"],
        });
        const { config } = await this.configHandler.loadConfig();
        if (config && !config.disableIndexing) {
          await this.codeBaseIndexer.refreshCodebaseIndexFiles(toRefresh);
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
          colocatedRulesUris.map((uri) => rulesCache.update(this.ide, uri)),
        ).then(() => {
          void this.configHandler.reloadConfig("Codebase rule file created");
        });
      }

      // If it's a local config being created, we want to reload all configs so it shows up in the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file created");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
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
          void this.configHandler.reloadConfig("Codebase rule file deleted");
        });
      }

      // If it's a local config being deleted, we want to reload all configs so it disappears from the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file deleted");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
          ".continue config-related file deleted",
        );
      }
    });

    on("files/closed", async ({ data }) => {
      console.debug("deleteChain called from files/closed");
      await NextEditProvider.getInstance().deleteChain();

      try {
        const fileUris = await this.ide.getOpenFiles();
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
        this.messenger.send("didCloseFiles", {
          uris: data.uris,
        });
      }
    });

    on("files/opened", async ({ data: { uris } }) => {
      if (uris) {
        for (const filepath of uris) {
          try {
            const ignore = await shouldIgnore(filepath, this.ide);
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
            this.ide,
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

    // Docs, etc. indexing
    on("indexing/reindex", async (msg) => {
      if (msg.data.type === "docs") {
        void this.docsService.reindexDoc(msg.data.id);
      }
    });
    on("indexing/abort", async (msg) => {
      if (msg.data.type === "docs") {
        this.docsService.abort(msg.data.id);
      }
    });
    on("indexing/setPaused", async (msg) => {
      if (msg.data.type === "docs") {
      }
    });
    on("docs/initStatuses", async (msg) => {
      void this.docsService.initStatuses();
    });
    on("docs/getDetails", async (msg) => {
      return await this.docsService.getDetails(msg.data.startUrl);
    });
    on("docs/getIndexedPages", async (msg) => {
      const pages = await this.docsService.getIndexedPages(msg.data.startUrl);
      return Array.from(pages);
    });

    on("didChangeSelectedProfile", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedProfileId(msg.data.id);
      }
    });

    on("auth/getAuthUrl", async (_msg) => {
      return { url: "" };
    });

    on("tools/call", async ({ data: { toolCall } }) =>
      this.handleToolCall(toolCall),
    );

    on(
      "tools/evaluatePolicy",
      async ({ data: { toolName, basePolicy, parsedArgs, processedArgs } }) => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          throw new Error("Config not loaded");
        }

        const tool = config.tools.find((t) => t.function.name === toolName);
        if (!tool) {
          return { policy: basePolicy };
        }

        // Extract display value for specific tools
        let displayValue: string | undefined;
        if (toolName === "runTerminalCommand" && parsedArgs.command) {
          displayValue = parsedArgs.command as string;
        }

        if (tool.evaluateToolCallPolicy) {
          const evaluatedPolicy = tool.evaluateToolCallPolicy(
            basePolicy,
            parsedArgs,
            processedArgs,
          );
          return { policy: evaluatedPolicy, displayValue };
        }
        return { policy: basePolicy, displayValue };
      },
    );

    on("tools/preprocessArgs", async ({ data: { toolName, args } }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Config not loaded");
      }

      const tool = config?.tools.find((t) => t.function.name === toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      try {
        const preprocessedArgs = await tool.preprocessArgs?.(args, {
          ide: this.ide,
        });
        return {
          preprocessedArgs,
        };
      } catch (e) {
        let errorReason =
          e instanceof ContinueError ? e.reason : ContinueErrorReason.Unknown;
        let errorMessage =
          e instanceof Error
            ? e.message
            : `Error preprocessing tool call args for ${toolName}\n${JSON.stringify(args)}`;
        return {
          preprocessedArgs: undefined,
          errorReason,
          errorMessage,
        };
      }
    });

    on("isItemTooBig", async ({ data: { item } }) => {
      return this.isItemTooBig(item);
    });

    // Process state handlers
    on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
      markProcessAsBackgrounded(toolCallId);
    });

    on(
      "process/isBackgrounded",
      async ({ data: { toolCallId }, messageId }) => {
        const isBackgrounded = isProcessBackgrounded(toolCallId);
        return isBackgrounded; // Return true to indicate the message was handled successfully
      },
    );

    on("process/killTerminalProcess", async ({ data: { toolCallId } }) => {
      await killTerminalProcess(toolCallId);
    });

    on("models/fetch", async (msg) => {
      try {
        return await fetchModels(
          msg.data.provider,
          msg.data.apiKey,
          msg.data.apiBase,
        );
      } catch (error: any) {
        void this.ide.showToast("error", error.message);
        return [];
      }
    });
  }

  private async handleToolCall(toolCall: ToolCall) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const tool = config.tools.find(
      (t) => t.function.name === toolCall.function.name,
    );

    if (!tool) {
      throw new Error(`Tool ${toolCall.function.name} not found`);
    }

    if (!config.selectedModelByRole.chat) {
      throw new Error("No chat model selected");
    }

    // Define a callback for streaming output updates
    const onPartialOutput = (params: {
      toolCallId: string;
      contextItems: ContextItem[];
    }) => {
      this.messenger.send("toolCallPartialOutput", params);
    };

    const startedAt = Date.now();
    luminaAgentRuntime.startToolCall(toolCall);

    try {
      const result = await callTool(tool, toolCall, {
        config,
        ide: this.ide,
        llm: config.selectedModelByRole.chat,
        fetch: (url, init) =>
          fetchwithRequestOptions(url, init, config.requestOptions),
        tool,
        toolCallId: toolCall.id,
        onPartialOutput,
        codeBaseIndexer: this.codeBaseIndexer,
      });

      luminaAgentRuntime.finishToolCall(
        toolCall,
        result,
        Date.now() - startedAt,
      );
      return result;
    } catch (error) {
      luminaAgentRuntime.failToolCall(toolCall, error, Date.now() - startedAt);
      throw error;
    }
  }

  private async getStartTalkGeminiConfig(preferredModel?: string) {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    const workspaceConfig = resolveStartTalkGeminiEnv(workspaceDirs);

    if (workspaceConfig.apiKey) {
      await this.startTalkConfigStore?.save(workspaceConfig);
    }

    const globalConfig = workspaceConfig.apiKey
      ? undefined
      : await this.startTalkConfigStore?.load();
    const { apiKey, model, thinkingLevel, voiceName } =
      selectStartTalkGeminiEnv(workspaceConfig, globalConfig);

    if (!apiKey) {
      throw new Error(
        "Start Talk needs GEMINI_API_KEY in a workspace .env, the global Start Talk env file, or VS Code Secret Storage.",
      );
    }

    return {
      apiKey,
      model: preferredModel ?? model,
      thinkingLevel,
      voiceName,
    };
  }

  private async getStartTalkConfigStatus(): Promise<StartTalkConfigStatus> {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    const workspaceConfig = resolveStartTalkGeminiEnv(workspaceDirs);
    const storedConfig = await this.startTalkConfigStore?.load();
    const selected = selectStartTalkGeminiEnv(workspaceConfig, storedConfig);
    const source = workspaceConfig.apiKey
      ? "workspace"
      : storedConfig?.apiKey
        ? "secureStorage"
        : "missing";

    return {
      configured: Boolean(selected.apiKey),
      source,
      model: selected.model,
      thinkingLevel: selected.thinkingLevel,
      voiceName: selected.voiceName,
    };
  }

  private async configureStartTalk(
    update: StartTalkConfigUpdate,
  ): Promise<void> {
    if (!this.startTalkConfigStore) {
      throw new Error("Secure Start Talk configuration is unavailable.");
    }

    const existing = await this.startTalkConfigStore.load();
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    const workspaceConfig = resolveStartTalkGeminiEnv(workspaceDirs);
    const apiKey =
      update.apiKey?.trim() || workspaceConfig.apiKey || existing?.apiKey;
    if (!apiKey) {
      throw new Error("A Gemini API key is required to configure Start Talk.");
    }

    await this.startTalkConfigStore.save({
      apiKey,
      model: update.model?.trim() || workspaceConfig.model || existing?.model,
      thinkingLevel:
        update.thinkingLevel ??
        workspaceConfig.thinkingLevel ??
        existing?.thinkingLevel,
      voiceName:
        update.voiceName?.trim() ||
        workspaceConfig.voiceName ||
        existing?.voiceName,
    });
  }

  /**
   * Skills on disk, joined with how they have actually been used.
   *
   * The SKILL.md files are the source of truth for which skills exist, and the
   * usage file only decorates them. Driving it the other way round would let a
   * telemetry entry for a deleted skill show up in settings as a skill the user
   * cannot open.
   */
  private async listSkillsWithUsage(): Promise<SkillWithUsage[]> {
    const { skills } = await loadMarkdownSkills(this.ide);
    const usageByName = new Map(
      getSkillUsageStore()
        .viewAll()
        .map((view) => [view.name, view]),
    );
    return skills.map((skill) => ({
      ...skill,
      usage: usageByName.get(skill.name),
    }));
  }

  private async isItemTooBig(item: ContextItemWithId) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return false;
    }

    const llm = config?.selectedModelByRole.chat;
    if (!llm) {
      throw new Error("No chat model selected");
    }

    const tokens = countTokens(item.content, llm.model);

    if (tokens > llm.contextLength - llm.completionOptions!.maxTokens!) {
      return true;
    }

    return false;
  }

  private createWhatsAppAutoResponder(): WhatsAppAutoResponder | undefined {
    // Windows-only and opt-in. Use "dry" to draft without sending, or an
    // explicit truthy value after reviewing the integration and permissions.
    if (process.platform !== "win32") {
      return undefined;
    }
    const flag = (process.env.LUMINA_WHATSAPP_AUTOREPLY ?? "").trim();
    if (!/^(1|true|on|yes|dry|dry-?run)$/iu.test(flag)) {
      return undefined;
    }
    return new WhatsAppAutoResponder({
      // Claude Code itself drafts every reply (headless CLI), not the locally
      // configured chat model — this is the owner's own assistant answering.
      generateReply: (prompt) =>
        this.composeWhatsAppReplyWithClaudeCode(prompt),
      dryRun: /^(dry|dry-?run)$/iu.test(flag) || undefined,
      onAudit: (entry) => this.handleAutoReplyAudit(entry),
      logger: (message) => console.warn(message),
    });
  }

  /** Locates the Claude Code CLI (claude.cmd) so the responder can invoke it. */
  private resolveClaudeCli(): string {
    const explicit = process.env.LUMINA_CLAUDE_CLI?.trim();
    if (explicit) {
      return explicit;
    }
    const appdata = process.env.APPDATA;
    if (appdata) {
      const npmCmd = joinPath(appdata, "npm", "claude.cmd");
      if (existsSync(npmCmd)) {
        return npmCmd;
      }
    }
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const nvmRoot = joinPath(local, "nvm");
      try {
        const found = readdirSync(nvmRoot)
          .map((version) => joinPath(nvmRoot, version, "claude.cmd"))
          .filter((candidate) => existsSync(candidate))
          .sort();
        if (found.length > 0) {
          return found[found.length - 1];
        }
      } catch {
        // nvm not present; fall through to PATH.
      }
    }
    return "claude"; // rely on PATH
  }

  /**
   * Drafts a WhatsApp reply by invoking Claude Code headlessly (one turn, text
   * out). The full prompt is piped over stdin so no message text ever lands in
   * argv. Returns the reply text, or null on any failure (the caller audits it).
   */
  private composeWhatsAppReplyWithClaudeCode(prompt: {
    system: string;
    user: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const cli = this.resolveClaudeCli();
      // Persona/rules go in as a real system prompt via a file (no escaping of
      // accents/quotes in argv); only the incoming message is piped over stdin.
      const sysFile = joinPath(tmpdir(), "lumina-whatsapp-persona.txt");
      try {
        writeFileSync(sysFile, prompt.system, "utf8");
      } catch {
        resolve(null);
        return;
      }
      let child;
      try {
        child = spawn(
          cli,
          [
            "-p",
            "--append-system-prompt-file",
            sysFile,
            "--output-format",
            "text",
            "--max-turns",
            "1",
          ],
          {
            cwd: tmpdir(), // neutral cwd: don't load this repo's CLAUDE.md/context
            windowsHide: true,
            shell: true,
            env: process.env,
          },
        );
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve(null);
      }, 90_000);
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        err += chunk.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(out.trim() || null);
        } else {
          console.warn(
            `[whatsapp-autoreply] claude exited ${code}: ${err.slice(0, 200)}`,
          );
          resolve(null);
        }
      });
      try {
        child.stdin?.write(prompt.user);
        child.stdin?.end();
      } catch {
        // stdin closed early; the close handler resolves.
      }
    });
  }

  private handleAutoReplyAudit(entry: AutoReplyAuditEntry): void {
    const summary = this.describeAutoReply(entry);
    // 1) Durable audit trail.
    try {
      appendFileSync(
        joinPath(getContinueGlobalPath(), "whatsapp-autoreply.jsonl"),
        `${JSON.stringify(entry)}\n`,
        "utf8",
      );
    } catch {
      // Never let logging break the responder.
    }
    // 2) Visible in the IDE.
    void this.ide.showToast("info", summary);
    // 3) Read aloud when the Start Talk orb is listening (best-effort; the item
    //    expires harmlessly if the voice is off).
    void this.postVoiceLine(summary);
  }

  private describeAutoReply(entry: AutoReplyAuditEntry): string {
    const sender = entry.sender || "un contacto";
    switch (entry.outcome) {
      case "sent":
        return `WhatsApp: le respondí a ${sender} — "${entry.reply ?? ""}".`;
      case "deferred":
        return `WhatsApp: ${sender} te escribió "${entry.incoming}". Preferí que respondas tú.`;
      case "blocked":
        return `WhatsApp: bloqueé una respuesta automática a ${sender} por seguridad.`;
      case "failed":
      default:
        return `WhatsApp: no pude responder a ${sender}${
          entry.detail ? ` (${entry.detail})` : ""
        }.`;
    }
  }

  private async postVoiceLine(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const port = process.env.LUMINA_BRIDGE_PORT?.trim() || "8765";
    const base = (
      process.env.LUMINA_WINDOWS_BRIDGE_URL?.trim() ||
      process.env.LUMINA_BRIDGE_URL?.trim() ||
      `http://127.0.0.1:${port}`
    ).replace(/\/+$/u, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      await fetch(`${base}/voice/claude-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
        signal: controller.signal,
      });
    } catch {
      // Bridge may be down or the orb closed; the audit log/toast still stand.
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleAddAutocompleteModel(
    msg: Message<{
      model: ModelDescription;
    }>,
  ) {
    const model = msg.data.model;
    editConfigFile(
      (config) => {
        return {
          ...config,
          tabAutocompleteModel: model,
        };
      },
      (config) => ({
        ...config,
        models: [
          ...(config.models ?? []),
          {
            name: model.title,
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            roles: ["autocomplete"],
            apiBase: model.apiBase,
          },
        ],
      }),
    );
    void this.configHandler.reloadConfig("Autocomplete model added");
  }

  private async handleFilesChanged({
    data,
  }: Message<{
    uris?: string[];
  }>): Promise<void> {
    if (data?.uris?.length) {
      const diffCache = GitDiffCache.getInstance(getDiffFn(this.ide));
      diffCache.invalidate();
      walkDirCache.invalidate(); // safe approach for now - TODO - only invalidate on relevant changes
      const currentProfileUri =
        this.configHandler.currentProfile?.profileDescription.uri ?? "";
      for (const uri of data.uris) {
        if (URI.equal(uri, currentProfileUri)) {
          // Trigger a toast notification to provide UI feedback that config has been updated
          const showToast =
            this.globalContext.get("showConfigUpdateToast") ?? true;
          if (showToast) {
            const selection = await this.ide.showToast(
              "info",
              "Config updated",
              "Don't show again",
            );
            if (selection === "Don't show again") {
              this.globalContext.update("showConfigUpdateToast", false);
            }
          }
          await this.configHandler.reloadConfig(
            "Current profile config file updated",
          );
          continue;
        }
        if (isColocatedRulesFile(uri)) {
          try {
            const codebaseRulesCache = CodebaseRulesCache.getInstance();
            void codebaseRulesCache.update(this.ide, uri).then(() => {
              void this.configHandler.reloadConfig("Codebase rule update");
            });
          } catch (e) {
            Logger.error(`Failed to update codebase rule: ${e}`);
          }
        } else if (isContinueConfigRelatedUri(uri)) {
          await this.configHandler.reloadConfig(
            "Local config-related file updated",
          );
        } else if (
          uri.endsWith(".continueignore") ||
          uri.endsWith(".gitignore")
        ) {
          // Reindex the workspaces
          this.invoke("index/forceReIndex", {
            shouldClearIndexes: true,
          });
        } else {
          const { config } = await this.configHandler.loadConfig();
          if (config && !config.disableIndexing) {
            // Reindex the file
            const ignore = await shouldIgnore(uri, this.ide);
            if (!ignore) {
              await this.codeBaseIndexer.refreshCodebaseIndexFiles([uri]);
            }
          }
        }
      }
    }
  }

  private async handleListModels(msg: Message<{ title: string }>) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const model =
      config.modelsByRole.chat.find(
        (model) => model.title === msg.data.title,
      ) ??
      config.modelsByRole.chat.find((model) =>
        model.title?.startsWith(msg.data.title),
      );

    try {
      if (model) {
        return await model.listModels();
      } else {
        if (msg.data.title === "Ollama") {
          const models = await new Ollama({ model: "" }).listModels();
          return models;
        } else if (msg.data.title === "Lemonade") {
          const models = await new Lemonade({ model: "" }).listModels();
          return models;
        } else {
          return undefined;
        }
      }
    } catch (e) {
      console.debug(`Error listing Ollama models: ${e}`);
      return undefined;
    }
  }

  private async handleCompleteOnboarding(
    msg: Message<CompleteOnboardingPayload>,
  ) {
    const { mode, provider, apiKey } = msg.data;

    let editConfigYamlCallback: (config: ConfigYaml) => ConfigYaml;

    switch (mode) {
      case OnboardingModes.LOCAL:
        editConfigYamlCallback = setupLocalConfig;
        break;

      case OnboardingModes.API_KEY:
        if (provider && apiKey) {
          editConfigYamlCallback = (config: ConfigYaml) =>
            setupProviderConfig(config, provider, apiKey);
        } else {
          editConfigYamlCallback = setupQuickstartConfig;
        }
        break;

      default:
        Logger.error(`Invalid mode: ${mode}`);
        editConfigYamlCallback = (config) => config;
    }

    editConfigFile((c) => c, editConfigYamlCallback);

    void this.configHandler.reloadConfig("Onboarding completed");
  }

  private getContextItems = async (
    msg: Message<{
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    }>,
  ) => {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const { name, query, fullInput, selectedCode } = msg.data;

    const llm = (await this.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No chat model selected");
    }

    const provider = config.contextProviders?.find(
      (provider) => provider.description.title === name,
    );
    if (!provider) {
      return [];
    }

    try {
      const items = await provider.getContextItems(query, {
        config,
        llm,
        embeddingsProvider: config.selectedModelByRole.embed,
        fullInput,
        ide: this.ide,
        selectedCode,
        reranker: config.selectedModelByRole.rerank,
        fetch: (url, init) =>
          // Important note: context providers fetch uses global request options not LLM request options
          // Because LLM calls are handled separately
          fetchwithRequestOptions(url, init, config.requestOptions),
        isInAgentMode: msg.data.isInAgentMode,
      });

      return items.map((item) => {
        const id: ContextItemId = {
          providerTitle: provider.description.title,
          itemId: uuidv4(),
        };

        return { ...item, id };
      });
    } catch (e) {
      let knownError = false;

      if (e instanceof Error) {
        // After removing transformers JS embeddings provider from jetbrains
        // Should no longer see this error
        // if (e.message.toLowerCase().includes("embeddings provider")) {
        //   knownError = true;
        //   const toastOption = "See Docs";
        //   void this.ide
        //     .showToast(
        //       "error",
        //       `Set up an embeddings model to use @${name}`,
        //       toastOption,
        //     )
        //     .then((userSelection) => {
        //       if (userSelection === toastOption) {
        //         void this.ide.openUrl(
        //           "https://docs.continue.dev/customize/model-roles/embeddings",
        //         );
        //       }
        //     });
        // }
      }
      if (!knownError) {
        void this.ide.showToast(
          "error",
          `Error getting context items from ${name}: ${e}`,
        );
      }
      return [];
    }
  };
}
