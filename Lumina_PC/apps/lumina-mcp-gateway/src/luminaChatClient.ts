import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { WebSocket, type RawData } from "ws";

import { config } from "./config.ts";

/**
 * Drives the Lumina Code chat from out-of-process, over the local WebSocket that
 * the VS Code extension publishes (see luminaMcpBridge.ts). It speaks the exact
 * same webview protocol Start Talk uses: send `startTalk/delegateToMain` and
 * await the matching `startTalk/mainResultReady`. The task runs as a real turn
 * in the visible chat, with the full agent and all its tools, and the agent's
 * final answer is returned here — so Claude (via the gateway) can both write in
 * the Lumina Code chat and read what it answered.
 *
 * Requires the Lumina Code sidebar to be open (that is where the delegation
 * bridge runs). If it is closed, or the extension host is down, the coordinates
 * file is missing / stale and we surface a clear, non-fatal error.
 */

interface BridgeCoordinates {
  url: string;
  port: number;
  token: string;
}

interface ProtocolMessage {
  messageType: string;
  data: { requestId?: string; text?: string; error?: boolean } & Record<
    string,
    unknown
  >;
  messageId: string;
}

export interface DelegateResult {
  ok: boolean;
  text: string;
  error?: string;
}

interface PendingCall {
  resolve: (result: DelegateResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | undefined;
let connecting: Promise<WebSocket> | undefined;
const pending = new Map<string, PendingCall>();

function readCoordinates(): BridgeCoordinates | undefined {
  if (!existsSync(config.chatBridgeFile)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(config.chatBridgeFile, "utf8")) as
      | Partial<BridgeCoordinates>
      | undefined;
    if (raw?.url && raw.token) {
      return { url: raw.url, port: raw.port ?? 0, token: raw.token };
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function handleMessage(raw: RawData): void {
  let message: ProtocolMessage;
  try {
    message = JSON.parse(raw.toString()) as ProtocolMessage;
  } catch {
    return;
  }
  if (message.messageType !== "startTalk/mainResultReady") {
    return;
  }
  const requestId = message.data?.requestId;
  if (!requestId) {
    return;
  }
  const entry = pending.get(requestId);
  if (!entry) {
    return;
  }
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve({
    ok: !message.data.error,
    text: String(message.data.text ?? ""),
    error: message.data.error ? "delegation_error" : undefined,
  });
}

function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }
  if (connecting) {
    return connecting;
  }
  const coordinates = readCoordinates();
  if (!coordinates) {
    return Promise.reject(new Error("chat_bridge_unavailable"));
  }
  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(coordinates.url);
    const onError = (error: Error) => {
      connecting = undefined;
      reject(error);
    };
    ws.once("error", onError);
    ws.once("open", () => {
      ws.removeListener("error", onError);
      socket = ws;
      connecting = undefined;
      ws.on("message", handleMessage);
      ws.on("close", () => {
        socket = undefined;
      });
      ws.on("error", () => {
        // A 'close' follows; reconnect happens lazily on the next call.
      });
      resolve(ws);
    });
  });
  return connecting;
}

/**
 * Sends a task to the Lumina Code chat and resolves with the agent's final
 * answer. Never throws: transport problems resolve as `{ ok: false, error }`.
 */
export async function delegateToLuminaCode(
  task: string,
  timeoutMs = 180_000,
): Promise<DelegateResult> {
  let ws: WebSocket;
  try {
    ws = await connect();
  } catch {
    return {
      ok: false,
      text: "",
      error: "chat_bridge_unavailable",
    };
  }

  const requestId = randomUUID();
  const message: ProtocolMessage = {
    messageType: "startTalk/delegateToMain",
    data: { requestId, task },
    messageId: randomUUID(),
  };

  return new Promise<DelegateResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, text: "", error: "timeout" });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    try {
      ws.send(JSON.stringify(message));
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ ok: false, text: "", error: "send_failed" });
    }
  });
}

/** True when the extension has published a chat-bridge coordinates file. */
export function isChatBridgeConfigured(): boolean {
  return readCoordinates() !== undefined;
}
