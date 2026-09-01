import type { CompletionProvider } from "../autocomplete/CompletionProvider";
import type { ChannelService } from "../channels/ChannelService.js";
import type { ConfigHandler } from "../config/ConfigHandler";
import type { CodebaseIndexer } from "../indexing/CodebaseIndexer";
import type DocsService from "../indexing/docs/DocsService";
import type { MemorySyncStatus } from "../memory/SupabaseMemorySync.js";
import type { NextEditProvider } from "../nextEdit/NextEditProvider";
import type { SecurityAuditService } from "../privacy/SecurityAuditService.js";
import type { ScheduledTaskService } from "../scheduler/ScheduledTaskService.js";
import type { StartTalkManager } from "../startTalk/index.js";
import type { GlobalContext } from "../util/GlobalContext";
import type { WorkboardService } from "../workboard/WorkboardService.js";

import type { ContextItemWithId, IDE, ToolCall } from "../index.js";
import type { FromCoreProtocol, ToCoreProtocol } from "../protocol";
import type { SkillWithUsage } from "../protocol/core";
import type { IMessenger, Message } from "../protocol/messenger";
import type {
  StartTalkConfigStatus,
  StartTalkConfigUpdate,
} from "../startTalk/env.js";
import type {
  StartTalkFallbackConfig,
  StartTalkProvider,
  StartTalkThinkingLevel,
} from "../startTalk/types.js";

/**
 * The credentials half of a Start Talk connection, resolved from the workspace
 * `.env` plus secure storage. Deliberately a subset of what
 * `StartTalkManager.connect` takes: the rest comes from the webview request.
 */
export interface StartTalkVoiceConfig {
  provider: StartTalkProvider;
  apiKey: string;
  model?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  voiceName?: string;
  fallback?: StartTalkFallbackConfig;
}

/**
 * The handler signature for one protocol message, derived from the protocol
 * itself so a callback can never drift from the message it serves.
 */
export type CoreHandler<T extends keyof ToCoreProtocol> = (
  message: Message<ToCoreProtocol[T][0]>,
) => Promise<ToCoreProtocol[T][1]> | ToCoreProtocol[T][1];

/**
 * `messenger.on`, already bound. Narrowed to the core protocol so a module
 * cannot register a message type core doesn't own.
 */
export type OnCoreMessage = <T extends keyof ToCoreProtocol>(
  messageType: T,
  handler: CoreHandler<T>,
) => void;

/**
 * The slice of `Core` that handlers are allowed to reach back into.
 *
 * Handlers used to live inside `Core` and call `this.whatever` freely. Rather
 * than widen those members to public — which would let anything in the codebase
 * poke at core's internals — each one is republished here as a bound callback.
 * The interface is therefore also the honest list of what still couples the
 * handler modules to `Core`; anything that leaves this list is one less reason
 * for a module to know `Core` exists at all.
 */
export interface CoreCallbacks {
  abortById(messageId: string): void;
  addMessageAbortController(id: string): AbortController;

  listSkillsWithUsage(): Promise<SkillWithUsage[]>;
  isItemTooBig(item: ContextItemWithId): Promise<boolean>;
  handleToolCall(toolCall: ToolCall): Promise<ToCoreProtocol["tools/call"][1]>;

  handleFilesChanged: CoreHandler<"files/changed">;
  handleAddAutocompleteModel: CoreHandler<"addAutocompleteModel">;
  handleCompleteOnboarding: CoreHandler<"onboarding/complete">;
  handleListModels: CoreHandler<"llm/listModels">;
  getContextItems: CoreHandler<"context/getContextItems">;

  getStartTalkVoiceConfig(
    preferredModel?: string,
  ): Promise<StartTalkVoiceConfig>;
  getStartTalkConfigStatus(): Promise<StartTalkConfigStatus>;
  configureStartTalk(update: StartTalkConfigUpdate): Promise<void>;
  refreshWhatsAppSuggestionMonitor(): void;

  /**
   * Memory sync state is read and written from several handlers, so it stays
   * owned by `Core` and is reached through accessors instead of being copied
   * into each module.
   */
  getMemorySyncStatus(): MemorySyncStatus;
  setMemorySyncStatus(status: MemorySyncStatus): void;
}

/**
 * Everything a handler module receives. Built once by `Core` and passed to
 * every module, so a module declares its dependencies by what it destructures.
 */
export interface CoreHandlerContext {
  readonly on: OnCoreMessage;
  readonly ide: IDE;
  readonly messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>;

  readonly configHandler: ConfigHandler;
  readonly globalContext: GlobalContext;
  readonly codeBaseIndexer: CodebaseIndexer;
  readonly completionProvider: CompletionProvider;
  readonly nextEditProvider: NextEditProvider;
  readonly docsService: DocsService;
  readonly startTalkManager: StartTalkManager;
  readonly scheduledTaskService: ScheduledTaskService;
  readonly workboardService: WorkboardService;
  readonly securityAudit: SecurityAuditService;
  readonly channelService: ChannelService;

  readonly core: CoreCallbacks;
}

/**
 * One cohesive group of message handlers.
 *
 * The point of the shape is that registration is data: `Core` holds a list of
 * modules and loops over it, so adding a group never edits the loop, and a
 * group can be registered against a stub context in a test without standing up
 * a whole `Core`.
 */
export interface CoreHandlerModule {
  /** Used in error messages and tests; matches the file name. */
  readonly name: string;
  register(ctx: CoreHandlerContext): void;
}

/** Small helper so modules read as `export default defineHandlers("x", ...)`. */
export function defineHandlers(
  name: string,
  register: (ctx: CoreHandlerContext) => void,
): CoreHandlerModule {
  return { name, register };
}
