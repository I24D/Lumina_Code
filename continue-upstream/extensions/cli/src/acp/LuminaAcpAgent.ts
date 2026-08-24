import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AGENT_METHODS,
  agent,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

import type { RuntimeHealth } from "../api/runtimeClient.js";
import type { RuntimeEvent } from "../api/runtimeEvents.js";

export interface AcpRuntimeClient {
  getHealth(): Promise<RuntimeHealth>;
  queueMessage(message: string): Promise<{ queued: true; position: number }>;
  resolvePermission(
    requestId: string,
    approved: boolean,
  ): Promise<{ success: true; approved: boolean }>;
  pause(): Promise<{ success: boolean; message: string }>;
  subscribeEvents(
    listener: (event: RuntimeEvent) => void | Promise<void>,
    options?: { signal?: AbortSignal; onOpen?: () => void },
  ): Promise<void>;
}

interface AcpSession {
  cwd: string;
  runtimeSessionId: string;
  busy: boolean;
  cancel?: AbortController;
  cancelTurn?: () => void;
}

function requireSession(
  sessions: Map<string, AcpSession>,
  sessionId: string,
): AcpSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown ACP session: ${sessionId}`);
  return session;
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function promptToRuntimeText(prompt: ContentBlock[]): string {
  const parts = prompt.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") {
      return `<resource name="${block.name}" uri="${block.uri}" />`;
    }
    throw new Error(`Unsupported ACP prompt content: ${block.type}`);
  });
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("ACP prompt must contain text or a resource link");
  return text;
}

function dataForSession(
  event: RuntimeEvent,
  runtimeSessionId: string,
): Record<string, unknown> | null {
  if (!event.data || typeof event.data !== "object") return null;
  const data = event.data as Record<string, unknown>;
  return data.sessionId === runtimeSessionId ? data : null;
}

function toolKind(
  toolName: string,
): "read" | "edit" | "search" | "execute" | "other" {
  if (/read|diagnostic/i.test(toolName)) return "read";
  if (/write|edit|patch/i.test(toolName)) return "edit";
  if (/search|grep|glob/i.test(toolName)) return "search";
  if (/bash|shell|terminal/i.test(toolName)) return "execute";
  return "other";
}

async function notifyToolCall(
  client: AgentContext,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  rawInput: unknown,
): Promise<void> {
  await client.notify(CLIENT_METHODS.session_update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: toolKind(toolName),
      status: "in_progress",
      rawInput,
    },
  });
}

async function relayPermission(
  runtime: AcpRuntimeClient,
  client: AgentContext,
  acpSessionId: string,
  data: Record<string, unknown>,
  options: { toolCallId: string; announceToolCall: boolean },
): Promise<void> {
  const requestId = String(data.requestId ?? "");
  const toolName = String(data.toolName ?? "Tool");
  if (!requestId) return;

  if (options.announceToolCall) {
    await notifyToolCall(
      client,
      acpSessionId,
      options.toolCallId,
      toolName,
      data.toolArgs,
    );
  }
  const response = await client.request(
    CLIENT_METHODS.session_request_permission,
    {
      sessionId: acpSessionId,
      toolCall: {
        toolCallId: options.toolCallId,
        title: toolName,
        kind: toolKind(toolName),
        status: "pending",
        rawInput: data.toolArgs,
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  );
  const approved =
    response.outcome.outcome === "selected" &&
    response.outcome.optionId === "allow_once";
  await runtime.resolvePermission(requestId, approved);
}

async function runPrompt(
  runtime: AcpRuntimeClient,
  session: AcpSession,
  params: PromptRequest,
  client: AgentContext,
  requestSignal: AbortSignal,
): Promise<PromptResponse> {
  if (session.busy) throw new Error("This ACP session is already processing");
  session.busy = true;
  const cancel = new AbortController();
  session.cancel = cancel;

  let openResolve!: () => void;
  let openReject!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  let turnResolve!: (response: PromptResponse) => void;
  let turnReject!: (error: unknown) => void;
  const turn = new Promise<PromptResponse>((resolve, reject) => {
    turnResolve = resolve;
    turnReject = reject;
  });
  const messageId = randomUUID();
  const toolCalls = new Map<string, string[]>();
  let terminal = false;
  const finish = (response: PromptResponse) => {
    if (!terminal) {
      terminal = true;
      turnResolve(response);
    }
  };
  const cancelTurn = () => {
    finish({ stopReason: "cancelled" });
    cancel.abort();
  };
  session.cancelTurn = cancelTurn;
  const onRequestAbort = () => {
    cancelTurn();
    void runtime.pause();
  };
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  const fail = (error: unknown) => {
    if (!terminal) {
      terminal = true;
      turnReject(error);
    }
  };

  const eventTask = runtime.subscribeEvents(
    async (event) => {
      const data = dataForSession(event, session.runtimeSessionId);
      if (!data) return;
      if (event.type === "run.content") {
        await client.notify(CLIENT_METHODS.session_update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: String(data.content ?? "") },
            messageId,
          },
        });
      } else if (event.type === "run.tool.started") {
        const toolName = String(data.toolName ?? "Tool");
        const toolCallId = randomUUID();
        const ids = toolCalls.get(toolName) ?? [];
        ids.push(toolCallId);
        toolCalls.set(toolName, ids);
        await notifyToolCall(
          client,
          params.sessionId,
          toolCallId,
          toolName,
          data.toolArgs,
        );
      } else if (
        event.type === "run.tool.result" ||
        event.type === "run.tool.error"
      ) {
        const toolName = String(data.toolName ?? "Tool");
        const toolCallId = toolCalls.get(toolName)?.shift();
        if (toolCallId) {
          await client.notify(CLIENT_METHODS.session_update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: event.type === "run.tool.error" ? "failed" : "completed",
              rawOutput:
                event.type === "run.tool.error" ? data.error : data.result,
            },
          });
        }
      } else if (event.type === "permission.requested") {
        const toolName = String(data.toolName ?? "Tool");
        const existingToolCallId = toolCalls.get(toolName)?.at(-1);
        await relayPermission(runtime, client, params.sessionId, data, {
          toolCallId: existingToolCallId ?? String(data.requestId),
          announceToolCall: !existingToolCallId,
        });
      } else if (event.type === "run.completed") {
        finish({ stopReason: "end_turn" });
      } else if (event.type === "run.paused") {
        finish({ stopReason: "cancelled" });
      } else if (event.type === "run.failed") {
        fail(new Error(String(data.error ?? "Lumina runtime failed")));
      }
    },
    { signal: cancel.signal, onOpen: openResolve },
  );
  eventTask.catch((error) => {
    if (!cancel.signal.aborted) {
      openReject(error);
      fail(error);
    }
  });

  try {
    await opened;
    await runtime.queueMessage(promptToRuntimeText(params.prompt));
    return await turn;
  } finally {
    cancel.abort();
    requestSignal.removeEventListener("abort", onRequestAbort);
    session.cancel = undefined;
    session.cancelTurn = undefined;
    session.busy = false;
    await eventTask.catch(() => undefined);
  }
}

/** Create a stable ACP v1 adapter backed exclusively by Lumina's v1 runtime. */
export function createLuminaAcpAgent(runtime: AcpRuntimeClient): AgentApp {
  const sessions = new Map<string, AcpSession>();
  let activeTurnSessionId: string | undefined;

  return agent({ name: "Lumina Code" })
    .onRequest(AGENT_METHODS.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: "Lumina Code", version: "1" },
      authMethods: [],
    }))
    .onRequest(AGENT_METHODS.session_new, async ({ params }) => {
      if (!path.isAbsolute(params.cwd)) {
        throw new Error("ACP session cwd must be an absolute path");
      }
      if (params.additionalDirectories?.length) {
        throw new Error("ACP additionalDirectories are not supported yet");
      }
      if (params.mcpServers.length) {
        throw new Error(
          "Configure MCP servers in Lumina; per-session ACP MCP servers are not supported",
        );
      }
      const health = await runtime.getHealth();
      if (!sameDirectory(health.workingDirectory, params.cwd)) {
        throw new Error(
          `ACP cwd ${params.cwd} does not match the Lumina runtime workspace ${health.workingDirectory}`,
        );
      }
      const sessionId = `${health.sessionId}:acp:${randomUUID()}`;
      sessions.set(sessionId, {
        cwd: path.resolve(params.cwd),
        runtimeSessionId: health.sessionId,
        busy: false,
      });
      return { sessionId };
    })
    .onRequest(
      AGENT_METHODS.session_prompt,
      async ({ params, client, signal }) => {
        if (activeTurnSessionId) {
          throw new Error(
            `Lumina runtime is already processing ACP session ${activeTurnSessionId}`,
          );
        }
        activeTurnSessionId = params.sessionId;
        try {
          return await runPrompt(
            runtime,
            requireSession(sessions, params.sessionId),
            params,
            client,
            signal,
          );
        } finally {
          activeTurnSessionId = undefined;
        }
      },
    )
    .onNotification(AGENT_METHODS.session_cancel, async ({ params }) => {
      const session = requireSession(sessions, params.sessionId);
      session.cancelTurn?.();
      if (session.busy) await runtime.pause();
    });
}
