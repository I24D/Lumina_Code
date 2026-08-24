import * as crypto from "node:crypto";
import * as vscode from "vscode";

import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { Message } from "core/protocol/messenger";
import { WebSocket, WebSocketServer } from "ws";

import { VsCodeWebviewProtocol } from "../webviewProtocol";

import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Puente WebSocket local que expone el protocolo del webview al orbe de Start
 * Talk (proceso Tauri, fuera de VS Code).
 *
 * El orbe carga la MISMA gui de Lumina Code; su transporte `vscode.postMessage`
 * viaja por aquí en vez de por el webview de VS Code. Como los mensajes se
 * enrutan por el mismísimo `VsCodeWebviewProtocol`, Start Talk, las tools, MCP y
 * la delegación al agente completo funcionan idénticos. Ver `webviewProtocol.ts`.
 *
 * Seguridad: escucha solo en 127.0.0.1 y exige un token de sesión en la query.
 */
export class OrbBridgeServer {
  private wss: WebSocketServer | undefined;
  private port = 0;
  private readonly token = crypto.randomBytes(16).toString("hex");

  constructor(private readonly webviewProtocol: VsCodeWebviewProtocol) {}

  /** Arranca (idempotente) y devuelve el puerto efímero + token de esta sesión. */
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

    const ownedSessionIds = new Set<string>();
    const pendingConnectMessageIds = new Set<string>();
    let cleanedUp = false;
    let authorizationInProgress = false;

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

    // Cada orbe es una superficie externa que recibe los mensajes core→webview.
    const sink = (msg: Message) => {
      const messageType = String(msg.messageType);
      const messageId = String(msg.messageId);
      const response = msg.data as
        | {
            done?: boolean;
            status?: string;
            content?: { sessionId?: unknown };
          }
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
    const denyDelegation = (requestId: string, reason: string) => {
      sink({
        messageType: "startTalk/mainResultReady",
        messageId: crypto.randomUUID(),
        data: { requestId, text: reason, error: true },
      });
    };
    const removeSink = this.webviewProtocol.addExternalSink(sink);

    socket.on("message", async (raw) => {
      let msg: Message;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // mensaje malformado: ignorar
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

      if (msg.messageType === "startTalk/delegateToMain") {
        const delegation = msg.data as
          | {
              requestId?: unknown;
              task?: unknown;
              userApproved?: unknown;
            }
          | undefined;
        const requestId =
          typeof delegation?.requestId === "string" ? delegation.requestId : "";
        const task =
          typeof delegation?.task === "string" ? delegation.task.trim() : "";

        if (!requestId || !task) {
          if (requestId) {
            denyDelegation(requestId, "Start Talk propuso una tarea invalida.");
          }
          return;
        }

        // New clients set this only after the user clicks the approval card.
        // Old/hot-reloaded clients get a second, extension-owned safety gate so
        // a stale event handler can never send work straight into the chat.
        const authorization = evaluateSurfaceAuthorization({
          surface: "start-talk",
          capability: "delegate-agent",
          userApproved: delegation?.userApproved === true,
          policy: "allow",
        });
        if (!authorization.authorized) {
          if (authorizationInProgress) {
            denyDelegation(
              requestId,
              "Solicitud cancelada: ya hay otra autorizacion pendiente.",
            );
            return;
          }

          authorizationInProgress = true;
          let choice: string | undefined;
          try {
            choice = await vscode.window.showWarningMessage(
              "Start Talk quiere enviar una tarea a Lumina Code",
              {
                modal: true,
                detail: `${task}\n\nLa tarea no se ejecutara sin tu autorizacion.`,
              },
              "Autorizar una vez",
            );
          } finally {
            authorizationInProgress = false;
          }

          if (choice !== "Autorizar una vez") {
            denyDelegation(
              requestId,
              "Solicitud cancelada: el usuario no autorizo esta tarea.",
            );
            return;
          }
          if (delegation) {
            delegation.userApproved = true;
          }
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
