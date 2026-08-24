import { services } from "../services/index.js";
import { ModelServiceState } from "../services/types.js";
import {
  getAgentExecutionContext,
  resolveToolPermissionState,
  runWithAgentExecutionContext,
  snapshotToolPermissionState,
} from "../stream/executionContext.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { escapeEvents } from "../util/cli.js";
import { logger } from "../util/logger.js";

import {
  type ChildSessionRecord,
  type ChildSessionStatus,
  createChildSession,
  saveChildSession,
  trackChildSessionUsage,
} from "./childSession.js";
import { registerChildExecution } from "./executionRegistry.js";
import {
  finalizeChildWorktree,
  permissionsCanWrite,
  prepareChildWorktree,
} from "./worktree.js";

/**
 * Options for executing a subagent
 */
export interface SubAgentExecutionOptions {
  agent: ModelServiceState;
  prompt: string;
  parentSessionId: string;
  abortController: AbortController;
  onOutputUpdate?: (output: string) => void;
}

/**
 * Result from executing a subagent
 */
export interface SubAgentResult {
  success: boolean;
  status: ChildSessionStatus;
  response: string;
  sessionId: string;
  parentSessionId: string;
  error?: string;
}

/**
 * Build system message for the agent
 */
async function buildAgentSystemMessage(
  agent: ModelServiceState,
  services: any,
  permissionMode: "normal" | "plan" | "auto",
): Promise<string> {
  const baseMessage = services.systemMessage
    ? await services.systemMessage.getSystemMessage(permissionMode)
    : "";

  const agentPrompt = agent.model?.chatOptions?.baseSystemMessage || "";

  // Combine base system message with agent-specific prompt
  if (agentPrompt) {
    return `${baseMessage}\n\n${agentPrompt}`;
  }

  return baseMessage;
}

/**
 * Execute a subagent in a child session
 */
async function executeSubAgentInChildSession(
  options: SubAgentExecutionOptions,
  childSession: ChildSessionRecord,
): Promise<SubAgentResult> {
  const {
    agent: subAgent,
    abortController,
    onOutputUpdate,
    parentSessionId,
  } = options;

  try {
    childSession.status = "running";
    saveChildSession(childSession);

    logger.debug("Starting subagent execution", {
      agent: subAgent.model?.name,
      sessionId: childSession.sessionId,
      parentSessionId,
      inheritedPermissionMode:
        getAgentExecutionContext()?.permissionState?.currentMode,
    });

    const { model, llmApi } = subAgent;
    if (!model || !llmApi) {
      throw new Error("Model or LLM API not available");
    }

    const chatHistory = childSession.history;

    const escapeHandler = () => {
      abortController.abort();
      chatHistory.push({
        message: {
          role: "user",
          content: "Subagent execution was cancelled by the user.",
        },
        contextItems: [],
      });
    };

    escapeEvents.on("user-escape", escapeHandler);

    try {
      let accumulatedOutput = "";

      // Execute the chat stream with child session
      await streamChatResponse(
        chatHistory,
        model,
        llmApi,
        abortController,
        {
          onContent: (content: string) => {
            accumulatedOutput += content;
            if (onOutputUpdate) {
              onOutputUpdate(accumulatedOutput);
            }
          },
          onToolResult: (result: string) => {
            // todo: skip tool outputs - show tool names and params
            accumulatedOutput += `\n\n${result}`;
            if (onOutputUpdate) {
              onOutputUpdate(accumulatedOutput);
            }
          },
        },
        false, // Not compacting
      );

      // The last message (mostly) contains the important output to be submitted back to the main agent
      const lastMessage = chatHistory.at(-1);
      const response =
        typeof lastMessage?.message?.content === "string"
          ? lastMessage.message.content
          : "";

      logger.debug("Subagent execution completed", {
        agent: model?.name,
        sessionId: childSession.sessionId,
        responseLength: response.length,
      });

      childSession.status = abortController.signal.aborted
        ? "canceled"
        : "completed";
      saveChildSession(childSession);

      return {
        success: childSession.status === "completed",
        status: childSession.status,
        response,
        sessionId: childSession.sessionId,
        parentSessionId,
      };
    } finally {
      escapeEvents.removeListener("user-escape", escapeHandler);
    }
  } catch (error: any) {
    logger.error("Subagent execution failed", {
      agent: subAgent.model?.name,
      sessionId: childSession.sessionId,
      error: error.message,
    });

    childSession.status = abortController.signal.aborted
      ? "canceled"
      : "failed";
    childSession.error = error.message;
    saveChildSession(childSession);

    return {
      success: false,
      status: childSession.status,
      response: "",
      sessionId: childSession.sessionId,
      parentSessionId,
      error: error.message,
    };
  }
}

/**
 * Execute a subagent as a traceable child of the active session.
 *
 * Permission, system-message, and history state are request-scoped, allowing
 * independent child sessions to run concurrently without mutating the primary
 * session. Nested delegation remains explicit so an agent cannot create an
 * unbounded delegation tree.
 */
export async function executeSubAgent(
  options: SubAgentExecutionOptions,
  childSessionOverride?: ChildSessionRecord,
): Promise<SubAgentResult> {
  const agentName = options.agent.model?.name || "subagent";
  const childSession =
    childSessionOverride ??
    createChildSession(options.parentSessionId, agentName, options.prompt);

  const activeContext = getAgentExecutionContext();
  if (activeContext?.kind === "subagent") {
    const error = `Nested subagents are not yet supported (active child session: ${activeContext.sessionId})`;
    childSession.status = "failed";
    childSession.error = error;
    saveChildSession(childSession);
    return {
      success: false,
      status: childSession.status,
      response: "",
      sessionId: childSession.sessionId,
      parentSessionId: options.parentSessionId,
      error,
    };
  }

  const inheritedPermissions = snapshotToolPermissionState(
    await resolveToolPermissionState(),
  );
  let workingDirectory: string | undefined;
  try {
    if (permissionsCanWrite(inheritedPermissions)) {
      workingDirectory = await prepareChildWorktree(childSession);
    }
  } catch (error) {
    const message = `Unable to create an isolated Git worktree for write-capable delegation: ${
      error instanceof Error ? error.message : String(error)
    }`;
    childSession.status = "failed";
    childSession.error = message;
    saveChildSession(childSession);
    return {
      success: false,
      status: "failed",
      response: "",
      sessionId: childSession.sessionId,
      parentSessionId: options.parentSessionId,
      error: message,
    };
  }
  const baseSystemMessage = await buildAgentSystemMessage(
    options.agent,
    services,
    inheritedPermissions.currentMode,
  );
  const systemMessage = workingDirectory
    ? `${baseSystemMessage}\n\nYou are working in an isolated Git worktree at ${workingDirectory}. Use this directory for every relative file and terminal operation. Changes require explicit user review before they can reach the primary working tree.`
    : baseSystemMessage;

  const unregister = registerChildExecution(
    childSession.sessionId,
    options.abortController,
  );
  try {
    return await runWithAgentExecutionContext(
      {
        sessionId: childSession.sessionId,
        parentSessionId: options.parentSessionId,
        kind: "subagent",
        permissionState: inheritedPermissions,
        systemMessageOverride: systemMessage,
        useChatHistoryService: false,
        workingDirectory,
        onUsage: (cost, usage) =>
          trackChildSessionUsage(childSession, cost, usage),
      },
      () => executeSubAgentInChildSession(options, childSession),
    );
  } finally {
    finalizeChildWorktree(childSession);
    unregister();
  }
}
