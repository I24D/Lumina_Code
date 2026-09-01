import {
  BlockType,
  ConfigResult,
  DevDataLogEvent,
  ModelRole,
} from "@continuedev/config-yaml";
import { ToolPolicy } from "@continuedev/terminal-security";

import {
  AutocompleteInput,
  RecentlyEditedRange,
} from "../autocomplete/util/types";
import { ProfileDescription } from "../config/ProfileLifecycleManager";
import { SharedConfigSchema } from "../config/sharedConfig";
import { GlobalContextModelSelections } from "../util/GlobalContext";

import {
  BaseSessionMetadata,
  BrowserSerializedContinueConfig,
  ChatMessage,
  CompiledMessagesResult,
  CompleteOnboardingPayload,
  ContextItem,
  ContextItemWithId,
  ContextSubmenuItem,
  DiffLine,
  DocsIndexingDetails,
  ExperimentalModelRoles,
  FileSymbolMap,
  IdeSettings,
  LLMFullCompletionOptions,
  McpUiState,
  MessageOption,
  ModelDescription,
  PromptLog,
  RangeInFile,
  RangeInFileWithNextEditInfo,
  SerializedContinueConfig,
  Session,
  SiteIndexingConfig,
  Skill,
  SlashCommandDescWithSource,
  StreamDiffLinesPayload,
  ToolCall,
} from "../";
import { AutocompleteCodeSnippet } from "../autocomplete/snippets/types";
import { GetLspDefinitionsFunction } from "../autocomplete/types";
import { ConfigHandler } from "../config/ConfigHandler";
import { ProcessedItem } from "../nextEdit/NextEditPrefetchQueue";
import { NextEditOutcome } from "../nextEdit/types";
import type { LuminaAssistantState } from "../orchestrator/index.js";
import type {
  ExperienceRecord,
  MemorySnapshot,
  VectorSearchResult,
} from "../memory/types.js";
import type { MemorySyncStatus } from "../memory/SupabaseMemorySync.js";
import type {
  StartTalkAudioChunk,
  StartTalkCaptureRequest,
  StartTalkConnectRequest,
  StartTalkConnectResponse,
  StartTalkMuteRequest,
  StartTalkNotificationSettingsRequest,
  StartTalkPlaybackReport,
  StartTalkReplyAuthorization,
  StartTalkSessionRequest,
  StartTalkTextInput,
  StartTalkToolResponseInput,
  StartTalkTranscriptEntry,
  StartTalkVideoFrameInput,
  StartTalkVideoStartRequest,
} from "../startTalk/index.js";
import type {
  StartTalkConfigStatus,
  StartTalkConfigUpdate,
} from "../startTalk/env.js";
import type { SessionGoal } from "../goals/sessionGoal.js";
import type {
  SessionSearchHit,
  SessionSummary,
} from "../learning/SessionSearchIndex.js";
import type { SkillUsageView } from "../learning/types.js";
import type { SkillLintFinding } from "../learning/types.js";
import type {
  SkillDraft,
  SkillSaveResult,
} from "../learning/SkillWorkshopService.js";
import type { LuminaPluginCatalogEntry } from "../config/PluginCatalogService.js";
import type { TodoSnapshot } from "../planner/types.js";
import type { VerificationRecipe } from "../verify/types.js";
import type { GitHubWorkItem } from "../integrations/GitHubWorkItemService.js";
import type {
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  WorktreeInfo,
} from "../worktrees/WorktreeService.js";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
} from "../scheduler/ScheduledTaskService.js";
import type {
  WorkboardCard,
  WorkboardCardInput,
  WorkboardSnapshot,
} from "../workboard/types.js";
import type {
  CapabilityDefinition,
  LuminaCapability,
  PermissionMap,
  PermissionPolicy,
} from "../privacy/permissions.js";
import type {
  SecurityAuditInput,
  SecurityAuditQuery,
  SecurityAuditSnapshot,
} from "../privacy/SecurityAuditService.js";
import type {
  LuminaChannelId,
  LuminaChannelPatch,
  LuminaChannelSnapshot,
} from "../channels/ChannelService.js";
import { ContinueErrorReason } from "../util/errors";

export enum OnboardingModes {
  API_KEY = "API Key",
  LOCAL = "Local",
}

export interface ListHistoryOptions {
  offset?: number;
  limit?: number;
  workspaceDirectory?: string;
}

/**
 * A skill as it appears in settings: the SKILL.md on disk plus how it has
 * actually been used. `usage` is absent for a skill that has never been read
 * or written through the tools — the honest representation of "no data yet",
 * which the UI renders differently from "used zero times".
 */
export type SkillWithUsage = Skill & { usage?: SkillUsageView };

export type SkillCurateAction = "archive" | "unarchive" | "pin" | "unpin";

export interface SessionSearchRequest {
  /** Omit or leave blank to browse recent sessions instead of searching. */
  query?: string;
  limit?: number;
  currentWorkspaceOnly?: boolean;
}

export interface SessionSearchResponse {
  hits: SessionSearchHit[];
  /** Populated instead of `hits` when no query was supplied. */
  recent: SessionSummary[];
}

export interface ForkSessionRequest {
  sessionId: string;
  historyIndex?: number;
  title?: string;
}

export interface ForkSessionToWorktreeRequest {
  sessionId: string;
  worktreePath: string;
  historyIndex?: number;
  title?: string;
}

export interface MemoryOverview {
  snapshot: MemorySnapshot;
  matches: VectorSearchResult<ExperienceRecord>[];
  sync: MemorySyncStatus;
}

export type ToCoreFromIdeOrWebviewProtocol = {
  // Special
  ping: [string, string];
  abort: [undefined, void];
  cancelApply: [undefined, void];

  // History
  "history/list": [ListHistoryOptions, BaseSessionMetadata[]];
  "history/delete": [{ id: string }, void];

  // Procedural memory (skills) and episodic memory (past sessions)
  "skills/list": [undefined, SkillWithUsage[]];
  "skills/curate": [
    { name: string; action: SkillCurateAction },
    SkillWithUsage[],
  ];
  "skills/workshop/lint": [SkillDraft, SkillLintFinding[]];
  "skills/workshop/save": [
    { draft: SkillDraft; overwrite?: boolean },
    { saved: SkillSaveResult; skills: SkillWithUsage[] },
  ];
  "plugins/list": [undefined, LuminaPluginCatalogEntry[]];
  "plugins/setEnabled": [
    { id: string; enabled: boolean },
    LuminaPluginCatalogEntry[],
  ];
  "sessions/search": [SessionSearchRequest, SessionSearchResponse];
  "sessions/fork": [ForkSessionRequest, Session];
  "sessions/forkToWorktree": [ForkSessionToWorktreeRequest, Session];
  "worktrees/list": [
    { workspaceDirectory?: string } | undefined,
    WorktreeInfo[],
  ];
  "worktrees/create": [CreateWorktreeRequest, WorktreeInfo];
  "worktrees/remove": [RemoveWorktreeRequest, void];
  "todos/list": [undefined, TodoSnapshot];
  "memory/get": [
    { query?: string; limit?: number } | undefined,
    MemoryOverview,
  ];
  "memory/delete": [{ id: string }, MemoryOverview];
  "memory/clear": [undefined, MemoryOverview];
  "memory/sync": [undefined, MemoryOverview];
  "workboard/get": [undefined, WorkboardSnapshot];
  "workboard/create": [WorkboardCardInput, WorkboardCard];
  "workboard/update": [
    { id: string; patch: Partial<WorkboardCardInput> },
    WorkboardCard,
  ];
  "workboard/delete": [{ id: string }, void];
  "verify/recipe": [undefined, VerificationRecipe | undefined];
  "history/load": [{ id: string }, Session];
  "history/save": [Session, void];
  "history/share": [{ id: string; outputDir?: string }, void];
  "history/clear": [undefined, void];
  "devdata/log": [DevDataLogEvent, void];
  "config/addOpenAiKey": [string, void];
  "config/addModel": [
    {
      model: SerializedContinueConfig["models"][number];
      role?: keyof ExperimentalModelRoles;
    },
    void,
  ];
  "config/addLocalWorkspaceBlock": [
    { blockType: BlockType; baseFilename?: string },
    void,
  ];
  "config/addGlobalRule": [undefined | { baseFilename?: string }, void];
  "config/deleteRule": [{ filepath: string }, void];
  "config/newPromptFile": [undefined, void];
  "config/newAssistantFile": [undefined, void];
  "config/ideSettingsUpdate": [IdeSettings, void];
  "config/getSerializedProfileInfo": [
    undefined,
    {
      result: ConfigResult<BrowserSerializedContinueConfig>;
      profileId: string | null;
      profiles: ProfileDescription[];
    },
  ];
  "config/deleteModel": [{ title: string }, void];
  "config/refreshProfiles": [
    (
      | undefined
      | {
          reason?: string;
          selectProfileId?: string;
        }
    ),
    void,
  ];
  "config/openProfile": [{ profileId: string | undefined }, void];
  "config/updateSharedConfig": [SharedConfigSchema, SharedConfigSchema];
  "config/updateSelectedModel": [
    {
      profileId: string;
      role: ModelRole;
      title: string | null;
    },
    GlobalContextModelSelections,
  ];
  "context/getContextItems": [
    {
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    },
    ContextItemWithId[],
  ];

  "mcp/reloadServer": [
    {
      id: string;
    },
    void,
  ];
  "mcp/setServerEnabled": [{ id: string; enabled: boolean }, void];
  "mcp/getPrompt": [
    {
      serverName: string;
      promptName: string;
      args?: Record<string, string>;
    },
    {
      prompt: string;
      description: string | undefined;
    },
  ];
  "mcp/startAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  "mcp/removeAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  "context/getSymbolsForFiles": [{ uris: string[] }, FileSymbolMap];
  "context/loadSubmenuItems": [{ title: string }, ContextSubmenuItem[]];
  "autocomplete/complete": [AutocompleteInput, string[]];
  "context/addDocs": [SiteIndexingConfig, void];
  "context/removeDocs": [Pick<SiteIndexingConfig, "startUrl">, void];
  "context/indexDocs": [{ reIndex: boolean }, void];
  "autocomplete/cancel": [undefined, void];
  "autocomplete/accept": [{ completionId: string }, void];
  "nextEdit/predict": [
    {
      input: AutocompleteInput;
      options?: {
        withChain?: boolean;
        usingFullFileDiff?: boolean;
      };
    },
    NextEditOutcome | undefined,
  ];
  "nextEdit/reject": [{ completionId: string }, void];
  "nextEdit/accept": [{ completionId: string }, void];
  "nextEdit/startChain": [undefined, void];
  "nextEdit/deleteChain": [undefined, void];
  "nextEdit/isChainAlive": [undefined, boolean];
  "nextEdit/queue/getProcessedCount": [undefined, number];
  "nextEdit/queue/dequeueProcessed": [undefined, ProcessedItem | null];
  "nextEdit/queue/processOne": [
    {
      ctx: {
        completionId: string;
        manuallyPassFileContents?: string;
        manuallyPassPrefix?: string;
        selectedCompletionInfo?: {
          text: string;
          range: Range;
        };
        isUntitledFile: boolean;
        recentlyVisitedRanges: AutocompleteCodeSnippet[];
        recentlyEditedRanges: RecentlyEditedRange[];
      };
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
      recentlyEditedRanges: RecentlyEditedRange[];
    },
    void,
  ];
  "nextEdit/queue/clear": [undefined, void];
  "nextEdit/queue/abort": [undefined, void];
  "llm/complete": [
    {
      prompt: string;
      completionOptions: LLMFullCompletionOptions;
      title: string;
    },
    string,
  ];
  "llm/listModels": [{ title: string }, string[] | undefined];
  "llm/streamChat": [
    {
      messages: ChatMessage[];
      completionOptions: LLMFullCompletionOptions;
      title: string;
      messageOptions?: MessageOption;
      legacySlashCommandData?: {
        command: SlashCommandDescWithSource;
        input: string;
        contextItems: ContextItemWithId[];
        historyIndex: number;
        selectedCode: RangeInFile[];
      };
    },
    AsyncGenerator<ChatMessage, PromptLog>,
  ];
  streamDiffLines: [StreamDiffLinesPayload, AsyncGenerator<DiffLine>];
  getDiffLines: [{ oldContent: string; newContent: string }, DiffLine[]];
  "llm/compileChat": [
    { messages: ChatMessage[]; options: LLMFullCompletionOptions },
    CompiledMessagesResult,
  ];
  "chatDescriber/describe": [
    {
      text: string;
    },
    string | undefined,
  ];
  "conversation/compact": [
    {
      index: number;
      sessionId: string;
    },
    string | undefined,
  ];
  "stats/getTokensPerDay": [
    undefined,
    { day: string; promptTokens: number; generatedTokens: number }[],
  ];
  "stats/getTokensPerModel": [
    undefined,
    { model: string; promptTokens: number; generatedTokens: number }[],
  ];
  "lumina/assistantState": [undefined, LuminaAssistantState];
  "lumina/reportToolResult": [
    {
      toolCall: ToolCall;
      result: {
        contextItems?: ContextItem[];
        errorMessage?: string;
        errorReason?: ContinueErrorReason;
      };
      durationMs?: number;
    },
    void,
  ];
  "startTalk/connect": [StartTalkConnectRequest, StartTalkConnectResponse];
  "startTalk/getConfigStatus": [undefined, StartTalkConfigStatus];
  "startTalk/configure": [StartTalkConfigUpdate, StartTalkConfigStatus];
  "startTalk/sendAudio": [StartTalkAudioChunk, void];
  "startTalk/sendText": [StartTalkTextInput, void];
  "startTalk/startCapture": [StartTalkCaptureRequest, void];
  "startTalk/setMuted": [StartTalkMuteRequest, void];
  "startTalk/setNotificationAnnouncements": [
    StartTalkNotificationSettingsRequest,
    void,
  ];
  "startTalk/authorizeReply": [StartTalkReplyAuthorization, void];
  "startTalk/getTranscript": [
    StartTalkSessionRequest,
    StartTalkTranscriptEntry[],
  ];
  // Voice delegation into the main chat (orb → core → sidebar → core → orb).
  "startTalk/delegateToMain": [
    {
      requestId: string;
      task: string;
      context?: string;
      /** Set only after the Start Talk confirmation UI was accepted. */
      userApproved?: boolean;
    },
    void,
  ];
  "startTalk/cancelMain": [
    {
      requestId: string;
      reason?: string;
    },
    void,
  ];
  "startTalk/mainResult": [
    { requestId: string; text: string; error?: boolean },
    void,
  ];
  "startTalk/endAudio": [StartTalkSessionRequest, void];
  "startTalk/stop": [StartTalkSessionRequest, void];
  "startTalk/sendToolResponse": [StartTalkToolResponseInput, void];
  "startTalk/startVideo": [StartTalkVideoStartRequest, void];
  "startTalk/stopVideo": [StartTalkSessionRequest, void];
  "startTalk/sendVideoFrame": [StartTalkVideoFrameInput, void];
  "startTalk/reportPlayback": [StartTalkPlaybackReport, void];
  // Privacidad: permisos de las capacidades reales de Lumina.
  "privacy/getPermissions": [
    undefined,
    { capabilities: CapabilityDefinition[]; permissions: PermissionMap },
  ];
  "privacy/setPermission": [
    { capability: LuminaCapability; policy: PermissionPolicy },
    PermissionMap,
  ];
  "privacy/resetPermissions": [undefined, PermissionMap];
  "security/audit/list": [
    SecurityAuditQuery | undefined,
    SecurityAuditSnapshot,
  ];
  "security/audit/record": [SecurityAuditInput, void];
  "security/audit/clear": [undefined, { removed: number }];
  "channels/get": [undefined, LuminaChannelSnapshot];
  "channels/update": [
    { id: LuminaChannelId; patch: LuminaChannelPatch },
    LuminaChannelSnapshot,
  ];
  // Metas de sesión: el agente sigue trabajando hasta cumplirlas.
  "goals/get": [{ sessionId: string }, SessionGoal | undefined];
  "goals/list": [undefined, SessionGoal[]];
  "goals/set": [
    { sessionId: string; text: string; maxTurns?: number },
    SessionGoal,
  ];
  "goals/applyVerdict": [
    { sessionId: string; raw: string },
    SessionGoal | undefined,
  ];
  "goals/clear": [{ sessionId: string }, void];
  // Sesiones precargadas desde issues y pull requests de GitHub.
  "github/getWorkItem": [{ reference: string }, GitHubWorkItem];
  "scheduler/list": [
    undefined,
    { tasks: ScheduledTask[]; runs: ScheduledTaskRun[] },
  ];
  "scheduler/create": [ScheduledTaskInput, ScheduledTask];
  "scheduler/update": [
    { id: string; patch: Partial<ScheduledTaskInput> },
    ScheduledTask,
  ];
  "scheduler/delete": [{ id: string }, void];
  "scheduler/runNow": [{ id: string }, ScheduledTaskRun];
  "scheduler/claimDue": [
    undefined,
    { task: ScheduledTask; run: ScheduledTaskRun } | undefined,
  ];
  "scheduler/reportRun": [
    {
      runId: string;
      status: "completed" | "failed";
      sessionId?: string;
      error?: string;
    },
    void,
  ];
  // Codebase indexing
  "index/setPaused": [boolean, void];
  "index/forceReIndex": [
    undefined | { dirs?: string[]; shouldClearIndexes?: boolean },
    void,
  ];
  "index/indexingProgressBarInitialized": [undefined, void];
  "onboarding/complete": [CompleteOnboardingPayload, void];

  // File changes
  "files/changed": [{ uris?: string[] }, void];
  "files/opened": [{ uris?: string[] }, void];
  "files/created": [{ uris?: string[] }, void];
  "files/deleted": [{ uris?: string[] }, void];
  "files/closed": [{ uris?: string[] }, void];
  "files/smallEdit": [
    {
      actions: RangeInFileWithNextEditInfo[];
      configHandler: ConfigHandler;
      getDefsFromLspFunction: GetLspDefinitionsFunction;
      recentlyEditedRanges: RecentlyEditedRange[];
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
    },
    void,
  ];

  // Docs etc. Indexing. TODO move codebase to this
  "indexing/reindex": [{ type: string; id: string }, void];
  "indexing/abort": [{ type: string; id: string }, void];
  "indexing/setPaused": [{ type: string; id: string; paused: boolean }, void];
  "docs/getSuggestedDocs": [undefined, void];
  "docs/initStatuses": [undefined, void];
  "docs/getDetails": [{ startUrl: string }, DocsIndexingDetails];
  "docs/getIndexedPages": [{ startUrl: string }, string[]];
  addAutocompleteModel: [{ model: ModelDescription }, void];

  "auth/getAuthUrl": [{ useOnboarding: boolean }, { url: string }];
  "tools/call": [
    { toolCall: ToolCall },
    {
      contextItems: ContextItem[];
      errorMessage?: string;
      errorReason?: ContinueErrorReason;
      mcpUiState?: McpUiState;
    },
  ];
  "tools/evaluatePolicy": [
    {
      toolName: string;
      basePolicy: ToolPolicy;
      parsedArgs: Record<string, unknown>;
      processedArgs?: Record<string, unknown>;
    },
    {
      policy: ToolPolicy;
      displayValue?: string;
      /** Full Access cannot bypass this decision. */
      requiresExplicitApproval?: boolean;
    },
  ];
  "tools/preprocessArgs": [
    { toolName: string; args: Record<string, unknown> },
    {
      preprocessedArgs?: Record<string, unknown>;
      errorReason?: ContinueErrorReason;
      errorMessage?: string;
    },
  ];
  "clipboardCache/add": [{ content: string }, void];
  isItemTooBig: [{ item: ContextItemWithId }, boolean];
  "process/markAsBackgrounded": [{ toolCallId: string }, void];
  "process/isBackgrounded": [{ toolCallId: string }, boolean];
  "process/killTerminalProcess": [{ toolCallId: string }, void];
  "mdm/setLicenseKey": [{ licenseKey: string }, boolean];
  "models/fetch": [
    { provider: string; apiKey?: string; apiBase?: string },
    {
      name: string;
      modelId?: string;
      description?: string;
      icon?: string;
      popular?: boolean;
      contextLength?: number;
      maxTokens?: number;
      supportsTools?: boolean;
    }[],
  ];
};
