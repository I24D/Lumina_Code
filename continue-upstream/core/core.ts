import { fetchwithRequestOptions } from "@continuedev/fetch";

import * as URI from "uri-js";
import { v4 as uuidv4 } from "uuid";

import { CompletionProvider } from "./autocomplete/CompletionProvider";

import { ConfigHandler } from "./config/ConfigHandler";

import { DataLogger } from "./data/log";

import { getChannelService } from "./channels/ChannelService.js";
import { CodebaseIndexer } from "./indexing/CodebaseIndexer";
import DocsService from "./indexing/docs/DocsService";
import { countTokens } from "./llm/countTokens";
import Lemonade from "./llm/llms/Lemonade";

import Ollama from "./llm/llms/Ollama";

import { callTool } from "./tools/callTool";

import { GlobalContext } from "./util/GlobalContext";

import { editConfigFile, migrateV1DevDataFiles } from "./util/paths";

import {
  CompleteOnboardingPayload,
  ContextItemId,
  ContextItemWithId,
  IdeSettings,
  ModelDescription,
  RangeInFile,
  ToolCall,
  type ContextItem,
  type IDE,
} from ".";

import { ConfigYaml } from "@continuedev/config-yaml";
import { getDiffFn, GitDiffCache } from "./autocomplete/snippets/gitDiffCache";

import {
  isColocatedRulesFile,
  isContinueConfigRelatedUri,
} from "./config/loadLocalAssistants";
import { CodebaseRulesCache } from "./config/markdown/loadCodebaseRules";
import { loadMarkdownSkills } from "./config/markdown/loadMarkdownSkills";

import { getSkillUsageStore } from "./learning/SkillUsageStore.js";

import { WorkboardService } from "./workboard/WorkboardService.js";
import {
  setupLocalConfig,
  setupProviderConfig,
  setupQuickstartConfig,
} from "./config/onboarding";

import { MCPManagerSingleton } from "./context/mcp/MCPManagerSingleton";

import { shouldIgnore } from "./indexing/shouldIgnore";
import { walkDirCache } from "./indexing/walkDir";
import { LLMLogger } from "./llm/logger";

import { NextEditProvider } from "./nextEdit/NextEditProvider";
import { luminaAgentRuntime } from "./orchestrator/index.js";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import { OnboardingModes, type SkillWithUsage } from "./protocol/core";
import type { IMessenger, Message } from "./protocol/messenger";
import {
  hasVoiceCredentials,
  resolveStartTalkProvider,
  resolveStartTalkVoiceEnv,
  selectStartTalkVoiceEnv,
  type StartTalkConfigStatus,
  type StartTalkConfigUpdate,
  type StartTalkVoiceConfigStore,
} from "./startTalk/env.js";
import {
  resolveModelForProvider,
  resolveVoiceForProvider,
} from "./startTalk/voices.js";
import type { StartTalkProvider } from "./startTalk/types.js";

import { SecurityAuditService } from "./privacy/SecurityAuditService.js";
import { StartTalkManager } from "./startTalk/index.js";
import { ScheduledTaskService } from "./scheduler/ScheduledTaskService.js";
import {
  getMemorySyncStatus,
  type MemorySyncStatus,
} from "./memory/SupabaseMemorySync.js";
import { ClaudeCodeCliClient } from "./startTalk/ClaudeCodeCliClient.js";
import {
  WhatsAppAutoResponder,
  type AutoReplyAuditEntry,
} from "./startTalk/WhatsAppAutoResponder.js";
import {
  CORE_HANDLER_MODULES,
  type CoreHandlerContext,
} from "./handlers/index.js";

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
  private workboardService: WorkboardService;
  private securityAudit = new SecurityAuditService();
  private channelService = getChannelService();
  private claudeCli = new ClaudeCodeCliClient();
  private memorySyncStatus: MemorySyncStatus = {
    configured: false,
    provider: "local",
    state: "local",
  };
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
    private readonly startTalkConfigStore?: StartTalkVoiceConfigStore,
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
      this.workboardService = new WorkboardService();

      // Optional trusted-contact suggestion monitor. It only drafts; sending is
      // always a normal tool call with non-bypassable user approval.
      this.refreshWhatsAppSuggestionMonitor();

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

      this.registerMessageHandlers();
    } catch (error) {
      Logger.error(error);
      throw error; // Re-throw to prevent partially initialized core
    }
  }

  /**
   * Wires the webview/IDE protocol to core.
   *
   * The handlers themselves live in `./handlers/*`, one file per feature area.
   * This method's only job is to build the context they share and hand it to
   * each module in turn; it used to be a single 1,350-line function carrying an
   * eslint exemption for its own size.
   */
  private registerMessageHandlers() {
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

    const ctx: CoreHandlerContext = {
      on: this.messenger.on.bind(this.messenger),
      ide: this.ide,
      messenger: this.messenger,

      configHandler: this.configHandler,
      globalContext: this.globalContext,
      codeBaseIndexer: this.codeBaseIndexer,
      completionProvider: this.completionProvider,
      nextEditProvider: this.nextEditProvider,
      docsService: this.docsService,
      startTalkManager: this.startTalkManager,
      scheduledTaskService: this.scheduledTaskService,
      workboardService: this.workboardService,
      securityAudit: this.securityAudit,
      channelService: this.channelService,

      // Bound rather than handed the instance: modules get exactly these, and
      // core's members stay private.
      core: {
        abortById: (messageId) => this.abortById(messageId),
        addMessageAbortController: (id) => this.addMessageAbortController(id),
        listSkillsWithUsage: () => this.listSkillsWithUsage(),
        isItemTooBig: (item) => this.isItemTooBig(item),
        handleToolCall: (toolCall) => this.handleToolCall(toolCall),
        handleFilesChanged: (msg) => this.handleFilesChanged(msg),
        handleAddAutocompleteModel: (msg) =>
          this.handleAddAutocompleteModel(msg),
        handleCompleteOnboarding: (msg) => this.handleCompleteOnboarding(msg),
        handleListModels: (msg) => this.handleListModels(msg),
        getContextItems: (msg) => this.getContextItems(msg),
        getStartTalkVoiceConfig: (preferredModel) =>
          this.getStartTalkVoiceConfig(preferredModel),
        getStartTalkConfigStatus: () => this.getStartTalkConfigStatus(),
        configureStartTalk: (update) => this.configureStartTalk(update),
        refreshWhatsAppSuggestionMonitor: () =>
          this.refreshWhatsAppSuggestionMonitor(),
        getMemorySyncStatus: () => this.memorySyncStatus,
        setMemorySyncStatus: (status) => {
          this.memorySyncStatus = status;
        },
      },
    };

    for (const handlerModule of CORE_HANDLER_MODULES) {
      handlerModule.register(ctx);
    }
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
    this.securityAudit.record({
      category: "tools",
      action: "execution_started",
      actor: "agent",
      outcome: "allowed",
      summary: `Inició la herramienta ${toolCall.function.name}.`,
      details: { tool: toolCall.function.name, toolCallId: toolCall.id },
    });

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
      this.securityAudit.record({
        category: "tools",
        action: "execution_finished",
        actor: "agent",
        outcome: "succeeded",
        summary: `Terminó la herramienta ${toolCall.function.name}.`,
        details: {
          tool: toolCall.function.name,
          toolCallId: toolCall.id,
          durationMs: Date.now() - startedAt,
        },
      });
      return result;
    } catch (error) {
      luminaAgentRuntime.failToolCall(toolCall, error, Date.now() - startedAt);
      this.securityAudit.record({
        category: "tools",
        action: "execution_finished",
        actor: "agent",
        outcome: "failed",
        summary: `Falló la herramienta ${toolCall.function.name}.`,
        details: {
          tool: toolCall.function.name,
          toolCallId: toolCall.id,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /**
   * Configuración de voz efectiva, ya resuelta a UN proveedor.
   *
   * El proveedor sale, por este orden, del modelo elegido en el orbe, de la
   * preferencia guardada y, si no hay ninguna, de la clave que exista. Devolver
   * ya la clave y la voz del proveedor activo es lo que evita el fallo mudo de
   * mandar una credencial de Google a OpenAI (o la voz `Leda` a la Realtime
   * API), que solo se manifiesta como una sesión que no conecta.
   */
  private async getStartTalkVoiceConfig(preferredModel?: string) {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    const workspaceConfig = resolveStartTalkVoiceEnv(workspaceDirs);

    if (hasVoiceCredentials(workspaceConfig)) {
      await this.startTalkConfigStore?.save(workspaceConfig);
    }

    const storedConfig = await this.startTalkConfigStore?.load();
    const selected = selectStartTalkVoiceEnv(workspaceConfig, storedConfig);
    const provider = resolveStartTalkProvider(selected, preferredModel);
    const apiKey =
      provider === "openai-realtime" ? selected.openAiApiKey : selected.apiKey;
    const fallbackProvider: StartTalkProvider =
      provider === "openai-realtime" ? "gemini-live" : "openai-realtime";
    const fallbackApiKey =
      fallbackProvider === "openai-realtime"
        ? selected.openAiApiKey
        : selected.apiKey;

    if (!apiKey) {
      throw new Error(
        provider === "openai-realtime"
          ? "Start Talk needs OPENAI_API_KEY in a workspace .env, the global Start Talk env file, or VS Code Secret Storage."
          : "Start Talk needs GEMINI_API_KEY in a workspace .env, the global Start Talk env file, or VS Code Secret Storage.",
      );
    }

    return {
      provider,
      apiKey,
      model: preferredModel ?? selected.model,
      thinkingLevel: selected.thinkingLevel,
      voiceName: resolveVoiceForProvider(
        provider,
        provider === "openai-realtime"
          ? selected.openAiVoiceName
          : selected.voiceName,
      ),
      ...(fallbackApiKey
        ? {
            fallback: {
              provider: fallbackProvider,
              apiKey: fallbackApiKey,
              model: resolveModelForProvider(fallbackProvider, selected.model),
              voiceName: resolveVoiceForProvider(
                fallbackProvider,
                fallbackProvider === "openai-realtime"
                  ? selected.openAiVoiceName
                  : selected.voiceName,
              ),
            },
          }
        : {}),
    };
  }

  private async getStartTalkConfigStatus(): Promise<StartTalkConfigStatus> {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    const workspaceConfig = resolveStartTalkVoiceEnv(workspaceDirs);
    const storedConfig = await this.startTalkConfigStore?.load();
    const selected = selectStartTalkVoiceEnv(workspaceConfig, storedConfig);
    const provider = resolveStartTalkProvider(selected);
    const activeKey =
      provider === "openai-realtime" ? "openAiApiKey" : "apiKey";
    const source = workspaceConfig[activeKey]
      ? "workspace"
      : storedConfig?.[activeKey]
        ? "secureStorage"
        : "missing";

    return {
      configured: Boolean(selected[activeKey]),
      provider,
      source,
      geminiConfigured: Boolean(selected.apiKey),
      openAiConfigured: Boolean(selected.openAiApiKey),
      model: selected.model,
      thinkingLevel: selected.thinkingLevel,
      voiceName: resolveVoiceForProvider("gemini-live", selected.voiceName),
      openAiVoiceName: resolveVoiceForProvider(
        "openai-realtime",
        selected.openAiVoiceName,
      ),
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
    const workspaceConfig = resolveStartTalkVoiceEnv(workspaceDirs);

    const apiKey =
      update.apiKey?.trim() || workspaceConfig.apiKey || existing?.apiKey;
    const openAiApiKey =
      update.openAiApiKey?.trim() ||
      workspaceConfig.openAiApiKey ||
      existing?.openAiApiKey;
    const provider =
      update.provider ?? existing?.provider ?? workspaceConfig.provider;

    // Guardar un proveedor sin su clave dejaría Start Talk configurado "a
    // medias": la UI diría que está listo y la sesión fallaría al conectar.
    if (provider === "openai-realtime" && !openAiApiKey) {
      throw new Error(
        "An OpenAI API key is required to use the OpenAI Realtime voice.",
      );
    }
    if (provider !== "openai-realtime" && !apiKey) {
      throw new Error("A Gemini API key is required to configure Start Talk.");
    }

    await this.startTalkConfigStore.save({
      provider,
      apiKey,
      openAiApiKey,
      model: update.model?.trim() || workspaceConfig.model || existing?.model,
      thinkingLevel:
        update.thinkingLevel ??
        workspaceConfig.thinkingLevel ??
        existing?.thinkingLevel,
      voiceName:
        update.voiceName?.trim() ||
        workspaceConfig.voiceName ||
        existing?.voiceName,
      openAiVoiceName:
        update.openAiVoiceName?.trim() ||
        workspaceConfig.openAiVoiceName ||
        existing?.openAiVoiceName,
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
    if (
      process.platform !== "win32" ||
      !this.channelService.hasSuggestionsEnabled()
    ) {
      return undefined;
    }
    return new WhatsAppAutoResponder({
      generateReply: (prompt) => this.claudeCli.generateReply(prompt),
      authorizeCandidate: (candidate) =>
        this.channelService.authorizeIngress(candidate.source, candidate.sender)
          .allowed,
      onAudit: (entry) => this.handleAutoReplyAudit(entry),
      logger: (message) => console.warn(message),
    });
  }

  private refreshWhatsAppSuggestionMonitor(): void {
    this.whatsappAutoResponder?.stop();
    this.whatsappAutoResponder = this.createWhatsAppAutoResponder();
    this.whatsappAutoResponder?.start();
  }

  private handleAutoReplyAudit(entry: AutoReplyAuditEntry): void {
    const summary = this.describeAutoReply(entry);
    // Durable but privacy-bounded: message bodies and drafts never enter the
    // audit file. The visible toast carries the transient local detail.
    this.securityAudit.record({
      category: "channels",
      action: "reply_suggestion",
      actor: "agent",
      outcome:
        entry.outcome === "suggested"
          ? "succeeded"
          : entry.outcome === "blocked"
            ? "blocked"
            : entry.outcome === "failed"
              ? "failed"
              : "rejected",
      summary: `Canal ${entry.source}: ${entry.outcome} para ${entry.sender || "contacto"}.`,
      details: { channel: entry.source, outcome: entry.outcome },
    });
    // Visible in the IDE.
    void this.ide.showToast("info", summary);
    // Read aloud when the Start Talk orb is listening (best-effort; the item
    //    expires harmlessly if the voice is off).
    void this.postVoiceLine(summary);
  }

  private describeAutoReply(entry: AutoReplyAuditEntry): string {
    const sender = entry.sender || "un contacto";
    switch (entry.outcome) {
      case "suggested":
        return `WhatsApp: borrador para ${sender} — "${entry.reply ?? ""}". No se envió.`;
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
