import * as crypto from "node:crypto";

import { Message } from "core/protocol/messenger";
import { WebSocket, WebSocketServer } from "ws";

import { WebviewProtocolHost } from "./WebviewProtocolHost";

import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Puente WebSocket local que expone el protocolo del webview al orbe de Start
 * Talk (proceso Tauri). Port de `extensions/vscode/src/extension/OrbBridgeServer.ts`
 * — identico salvo que aqui el protocolo es `WebviewProtocolHost` (standalone) en
 * vez del `VsCodeWebviewProtocol`.
 *
 * Seguridad: escucha solo en 127.0.0.1 y exige un token de sesion en la query.
 */
export class OrbBridgeServer {
  private wss: WebSocketServer | undefined;
  private port = 0;
  private readonly token = crypto.randomBytes(16).toString("hex");

  constructor(private readonly webviewProtocol: WebviewProtocolHost) {}

  /** Arranca (idempotente) y devuelve el puerto efimero + token de esta sesion. */
  async start(): Promise<{ port: number; token: string }> {
    if (this.wss) {
      return { port: this.port, token: this.token };
    }

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

      wss.on("listening", () => {
        this.wss = wss;
        this.port = (wss.address() as AddressInfo).port;
        resolve({ port: this.port, token: this.token });
      });
      wss.on("error", reject);
      wss.on("connection", (socket, req) => this.onConnection(socket, req));
    });
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "", "ws://127.0.0.1");
    if (url.searchParams.get("token") !== this.token) {
      socket.close(1008, "invalid token");
      return;
    }
    console.log("[orb-bridge] orbe conectado");

    const ownedSessionIds = new Set<string>();
    const pendingConnectMessageIds = new Set<string>();
    let cleanedUp = false;

    const stopOwnedSession = (sessionId: string) => {
      void this.webviewProtocol.handleExternalMessage(
        {
          messageType: "startTalk/stop",
          messageId: crypto.randomUUID(),
          data: { sessionId },
        },
        () => {},
      );
    };

    // Cada orbe es una superficie externa que recibe los mensajes core->webview.
    const sink = (msg: Message) => {
      const messageType = String(msg.messageType);
      const messageId = String(msg.messageId);
      const response = msg.data as
        | { done?: boolean; status?: string; content?: { sessionId?: unknown } }
        | undefined;

      if (
        messageType === "startTalk/connect" &&
        pendingConnectMessageIds.has(messageId) &&
        response?.done
      ) {
        pendingConnectMessageIds.delete(messageId);
        const sessionId = response.content?.sessionId;
        if (response.status === "success" && typeof sessionId === "string") {
          if (cleanedUp) {
            stopOwnedSession(sessionId);
          } else {
            ownedSessionIds.add(sessionId);
          }
        }
      }

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };
    const removeSink = this.webviewProtocol.addExternalSink(sink);

    socket.on("message", (raw) => {
      let msg: Message;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // mensaje malformado: ignorar
      }

      if (
        typeof msg.messageType === "string" &&
        msg.messageType.startsWith("startTalk/") &&
        msg.messageType !== "startTalk/sendAudio" &&
        msg.messageType !== "startTalk/sendVideoFrame"
      ) {
        console.log(`[orb-bridge] <- ${msg.messageType}`);
      }

      if (msg.messageType === "startTalk/connect") {
        pendingConnectMessageIds.add(String(msg.messageId));
      } else if (msg.messageType === "startTalk/stop") {
        const sessionId = (msg.data as { sessionId?: unknown } | undefined)
          ?.sessionId;
        if (typeof sessionId === "string") {
          ownedSessionIds.delete(sessionId);
        }
      }

      void this.webviewProtocol.handleExternalMessage(msg, sink);
    });

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      removeSink();
      for (const sessionId of ownedSessionIds) {
        stopOwnedSession(sessionId);
      }
      ownedSessionIds.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  dispose(): void {
    this.wss?.close();
    this.wss = undefined;
  }
}
