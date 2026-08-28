import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

import { evaluateSurfaceAuthorization } from "@continuedev/terminal-security";
import { Message } from "core/protocol/messenger";
import { WebSocket, WebSocketServer } from "ws";

import { VsCodeWebviewProtocol } from "../webviewProtocol";

import { buildOrbBootstrapScript } from "./orbBootstrap";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Servidor local del orbe de Start Talk: sirve la MISMA gui de Lumina Code en
 * una pestaña del navegador y expone el protocolo del webview por WebSocket.
 *
 * Antes el orbe era una ventana Tauri que embebía la gui en tiempo de
 * compilación. Servirla en vez de empotrarla elimina el ciclo de `cargo build`
 * y, con él, toda la clase de fallos por bundle desincronizado: aquí siempre se
 * sirve el bundle que hay en disco.
 *
 * HTTP y WebSocket comparten puerto para que haya UNA sola URL y UN solo token.
 * El transporte `vscode.postMessage` de la gui viaja por el WebSocket en vez de
 * por el webview de VS Code; como los mensajes se enrutan por el mismísimo
 * `VsCodeWebviewProtocol`, Start Talk, las tools, MCP y la delegación al agente
 * funcionan idénticos. Ver `webviewProtocol.ts`.
 *
 * Seguridad: escucha solo en 127.0.0.1 (que además es contexto seguro para el
 * navegador, así que el micrófono funciona) y exige el token de sesión tanto
 * para servir la página como para abrir el WebSocket.
 */

/** Tipos MIME de lo que compone el bundle de la gui. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Raíz del bundle de la gui que se sirve al orbe.
 *
 * El orden importa y no es cosmético: en un checkout de desarrollo conviven la
 * copia empaquetada (`extensions/vscode/gui`, que solo se refresca al generar
 * el VSIX) y la recién compilada (`gui/dist`). Servir la primera en desarrollo
 * mostraría una interfaz de hace días sin que nada fallara —justo el fallo
 * silencioso que el orbe embebido ya provocaba—, así que en desarrollo manda
 * `gui/dist` y en producción la copia empaquetada.
 */
export function resolveOrbFrontendRoot(
  extensionPath: string,
  isDevelopment = false,
): string | undefined {
  const packaged = path.join(extensionPath, "gui");
  const built = path.resolve(extensionPath, "../../gui/dist");
  const candidates = isDevelopment ? [built, packaged] : [packaged, built];
  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.html")),
  );
}

export class OrbBridgeServer {
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private port = 0;
  private token = crypto.randomBytes(16).toString("hex");

  /**
   * `frontendRoot` solo lo necesita el orbe, que además de mensajes sirve la
   * interfaz. El puente MCP usa la misma clase como transporte WebSocket puro y
   * lo omite: sin raíz de bundle, el servidor no sirve ninguna página.
   */
  constructor(
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly frontendRoot?: string,
  ) {}

  /** URL que abre el orbe en el navegador, con el token de esta sesión. */
  orbUrl(): string {
    return `http://127.0.0.1:${this.port}/?token=${this.token}`;
  }

  /**
   * Arranca (idempotente) y devuelve el puerto + token. `preferredPort` permite
   * recuperar el mismo puerto tras recargar el host de la extensión, para que
   * una pestaña ya abierta se reconecte sola en vez de quedarse huérfana.
   */
  async start(options?: {
    preferredPort?: number;
    token?: string;
  }): Promise<{ port: number; token: string }> {
    if (this.server) {
      return { port: this.port, token: this.token };
    }
    if (options?.token) {
      this.token = options.token;
    }

    const listen = (port: number): Promise<{ port: number; token: string }> =>
      new Promise((resolve, reject) => {
        const server = http.createServer((req, res) =>
          this.onHttpRequest(req, res),
        );
        const wss = new WebSocketServer({ server });
        wss.on("connection", (socket, req) => this.onConnection(socket, req));
        // Un evento `error` sin oyente en un EventEmitter tumba el proceso. El
        // servidor de sockets hereda los fallos del HTTP al que va adosado, así
        // que un puerto ocupado bastaría para llevarse por delante el host de
        // la extensión entera.
        wss.on("error", () => undefined);

        const onListenError = (error: Error) => {
          // Sin cerrarlos, el par fallido queda colgando en el bucle de eventos.
          wss.close();
          server.close();
          reject(error);
        };

        server.once("error", onListenError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onListenError);
          // A partir de aquí los fallos son de una conexión, no del arranque:
          // se registran, pero no derriban el host.
          server.on("error", (error) =>
            console.error(`[OrbBridgeServer] ${error.message}`),
          );
          this.server = server;
          this.wss = wss;
          this.port = (server.address() as AddressInfo).port;
          resolve({ port: this.port, token: this.token });
        });
      });

    const preferred = options?.preferredPort;
    if (preferred && preferred > 0) {
      try {
        return await listen(preferred);
      } catch {
        // El puerto puede estar ocupado por otra cosa: se cae a uno efímero.
      }
    }
    return listen(0);
  }

  /**
   * Sirve el bundle de la gui. La página inicial exige el token; los recursos
   * (js/css/fuentes) no, porque son el mismo bundle que ya se distribuye en el
   * VSIX y el navegador no los pide con la query. Lo que el token protege es el
   * arranque, que es donde va el secreto del puente.
   */
  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const frontendRoot = this.frontendRoot;
    if (!frontendRoot) {
      // Transporte WebSocket puro (puente MCP): no hay interfaz que servir.
      res.writeHead(404).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isEntry = url.pathname === "/" || url.pathname === "/index.html";

    if (isEntry) {
      if (url.searchParams.get("token") !== this.token) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Start Talk: token invalido. Abrelo desde Lumina Code.");
        return;
      }
      this.serveEntry(res);
      return;
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
    const target = path.resolve(frontendRoot, relative);
    // Nunca servir fuera de la raíz del bundle.
    if (
      target !== frontendRoot &&
      !target.startsWith(frontendRoot + path.sep)
    ) {
      res.writeHead(403).end();
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type":
          CONTENT_TYPES[path.extname(target).toLowerCase()] ??
          "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  }

  /** index.html con el arranque del puente inyectado antes que la gui. */
  private serveEntry(res: ServerResponse): void {
    let html: string;
    try {
      html = fs.readFileSync(
        path.join(this.frontendRoot ?? "", "index.html"),
        "utf8",
      );
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Start Talk: no se encontro el bundle de la interfaz.");
      return;
    }

    const bootstrap = `<script>${buildOrbBootstrapScript(
      `ws://127.0.0.1:${this.port}/?token=${this.token}`,
    )}</script>`;
    const injected = html.includes("<head>")
      ? html.replace("<head>", `<head>${bootstrap}`)
      : `${bootstrap}${html}`;

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(injected);
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
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }
}
