import { AsyncLocalStorage } from "node:async_hooks";

import { services } from "../services/index.js";
import { serviceContainer } from "../services/ServiceContainer.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import { ModelServiceState, SERVICE_NAMES } from "../services/types.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { escapeEvents } from "../util/cli.js";
import { logger } from "../util/logger.js";

import {
  type ChildSessionRecord,
  type ChildSessionStatus,
  createChildSession,
  saveChildSession,
} from "./childSession.js";

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

const subagentExecutionContext = new AsyncLocalStorage<{
  sessionId: string;
}>();

let subagentExecutionTail: Promise<void> = Promise.resolve();

async function runSubagentExclusive<T>(task: () => Promise<T>): Promise<T> {
  const previous = subagentExecutionTail;
  let release: () => void = () => undefined;
  subagentExecutionTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Build system message for the agent
 */
async function buildAgentSystemMessage(
  agent: ModelServiceState,
  services: any,
): Promise<string> {
  const baseMessage = services.systemMessage
    ? await services.systemMessage.getSystemMessage(
        services.toolPermissions.getState().currentMode,
      )
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
    const mainAgentPermissionsState =
      await serviceContainer.get<ToolPermissionServiceState>(
        SERVICE_NAMES.TOOL_PERMISSIONS,
      );

    childSession.status = "running";
    saveChildSession(childSession);

    logger.debug("Starting subagent execution", {
      agent: subAgent.model?.name,
      sessionId: childSession.sessionId,
      parentSessionId,
      inheritedPermissionMode: mainAgentPermissionsState.currentMode,
    });

    const { model, llmApi } = subAgent;
    if (!model || !llmApi) {
      throw new Error("Model or LLM API not available");
    }

    // Security invariant: a delegated task must never gain more authority than
    // its parent.  The stream reads the existing permission state from the
    // service container, so no override is needed here.

    // Build agent system message
    const systemMessage = await buildAgentSystemMessage(subAgent, services);

    // Store original system message function
    const originalGetSystemMessage = services.systemMessage?.getSystemMessage;

    // Store original ChatHistoryService ready state
    const chatHistorySvc = services.chatHistory;
    const originalIsReady =
      chatHistorySvc && typeof chatHistorySvc.isReady === "function"
        ? chatHistorySvc.isReady
        : undefined;

    // Override system message for this execution
    if (services.systemMessage) {
      services.systemMessage.getSystemMessage = async () => systemMessage;
    }

    // Temporarily disable ChatHistoryService to prevent it from interfering with child session
    if (chatHistorySvc && originalIsReady) {
      chatHistorySvc.isReady = () => false;
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
      if (escapeHandler) {
        escapeEvents.removeListener("user-escape", escapeHandler);
      }

      // Restore original system message function
      if (services.systemMessage && originalGetSystemMessage) {
        services.systemMessage.getSystemMessage = originalGetSystemMessage;
      }

      // Restore original ChatHistoryService ready state
      if (chatHistorySvc && originalIsReady) {
        chatHistorySvc.isReady = originalIsReady;
      }
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
 * The current stream implementation temporarily swaps two process-global
 * services (system message and chat history readiness).  Until those services
 * become request-scoped, serialize this critical section so parallel tool calls
 * cannot leak state into one another. Nested delegation is rejected explicitly
 * instead of deadlocking on the queue.
 */
export async function executeSubAgent(
  options: SubAgentExecutionOptions,
): Promise<SubAgentResult> {
  const agentName = options.agent.model?.name || "subagent";
  const childSession = createChildSession(
    options.parentSessionId,
    agentName,
    options.prompt,
  );

  const activeContext = subagentExecutionContext.getStore();
  if (activeContext) {
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

  return runSubagentExclusive(() =>
    subagentExecutionContext.run({ sessionId: childSession.sessionId }, () =>
      executeSubAgentInChildSession(options, childSession),
    ),
  );
}
