import { FromWebviewProtocol, ToWebviewProtocol } from "core/protocol";
import { Message } from "core/protocol/messenger";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";

import { IMessenger } from "../../../core/protocol/messenger";

import { handleLLMError } from "./util/errorHandling";

/**
 * Destino adicional para los mensajes core→webview. Lo usa el orbe de Start Talk
 * (proceso Tauri) que se conecta por WebSocket: la misma gui corre fuera de VS
 * Code y recibe/emite los mismos mensajes del protocolo, así que Start Talk y la
 * delegación al agente funcionan idénticos. Ver `OrbBridgeServer`.
 */
export type ExternalWebviewSink = (msg: Message) => void;

export class VsCodeWebviewProtocol
  implements IMessenger<FromWebviewProtocol, ToWebviewProtocol>
{
  listeners = new Map<
    keyof FromWebviewProtocol,
    ((message: Message) => any)[]
  >();

  /** Superficies externas (orbe Tauri) suscritas a los mensajes core→webview. */
  private externalSinks = new Set<ExternalWebviewSink>();

  send(messageType: string, data: any, messageId?: string): string {
    const id = messageId ?? uuidv4();
    const msg: Message = {
      messageType,
      data,
      messageId: id,
    };
    this.webview?.postMessage(msg);
    for (const sink of this.externalSinks) {
      try {
        sink(msg);
      } catch {
        // una superficie caída no debe tumbar al resto
      }
    }
    return id;
  }

  on<T extends keyof FromWebviewProtocol>(
    messageType: T,
    handler: (
      message: Message<FromWebviewProtocol[T][0]>,
    ) => Promise<FromWebviewProtocol[T][1]> | FromWebviewProtocol[T][1],
  ): void {
    if (!this.listeners.has(messageType)) {
      this.listeners.set(messageType, []);
    }
    this.listeners.get(messageType)?.push(handler);
  }

  _webview?: vscode.Webview;
  _webviewListener?: vscode.Disposable;

  get webview(): vscode.Webview | undefined {
    return this._webview;
  }

  /**
   * Lógica común de manejo de un mensaje entrante. `respond` queda ligado a la
   * superficie de origen (sidebar o un orbe concreto) para que la respuesta —y
   * el streaming— vuelvan solo a quien preguntó.
   */
  private async handleIncomingMessage(
    msg: Message,
    respond: (data: any) => void,
  ): Promise<void> {
    if (!("messageType" in msg) || !("messageId" in msg)) {
      throw new Error(`Invalid webview protocol msg: ${JSON.stringify(msg)}`);
    }

    const handlers =
      this.listeners.get(msg.messageType as keyof FromWebviewProtocol) || [];
    for (const handler of handlers) {
      try {
        const response = await handler(msg);
        // For generator types e.g. llm/streamChat
        if (response && typeof response[Symbol.asyncIterator] === "function") {
          let next = await response.next();
          while (!next.done) {
            respond({
              done: false,
              content: next.value,
              status: "success",
            });
            next = await response.next();
          }
          respond({
            done: true,
            content: next.value,
            status: "success",
          });
        } else {
          respond({ done: true, content: response, status: "success" });
        }
      } catch (e: any) {
        if (await handleLLMError(e)) {
          // Respond without an error, so the UI doesn't show the error component
          respond({ done: true, status: "error" });
        }
        let message = e.message;
        respond({ done: true, error: message, status: "error" });

        const stringified = JSON.stringify({ msg }, null, 2);
        console.error(`Error handling webview message: ${stringified}\n\n${e}`);

        if (
          stringified.includes("llm/streamChat") ||
          stringified.includes("chatDescriber/describe")
        ) {
          return;
        }

        if (e.cause) {
          if (e.cause.name === "ConnectTimeoutError") {
            message = `Connection timed out. If you expect it to take a long time to connect, you can increase the timeout in your config by setting "requestOptions": { "timeout": 10000 }. You can find the full config reference here: https://docs.continue.dev/reference/config`;
          } else if (e.cause.code === "ECONNREFUSED") {
            message = `Connection was refused. This likely means that there is no server running at the specified URL. If you are running your own server you may need to set the "apiBase" parameter in config.json. For example, you can set up an OpenAI-compatible server like here: https://docs.continue.dev/reference/Model%20Providers/openai#openai-compatible-servers--apis`;
          } else {
            message = `The request failed with "${e.cause.name}": ${e.cause.message}. If you're having trouble setting up Continue, please see the troubleshooting guide for help.`;
          }
        }
      }
    }
  }

  set webview(webView: vscode.Webview) {
    this._webview = webView;
    this._webviewListener?.dispose();

    this._webviewListener = this._webview.onDidReceiveMessage((msg: Message) =>
      this.handleIncomingMessage(msg, (data) =>
        this._webview?.postMessage({
          messageType: msg.messageType,
          data,
          messageId: msg.messageId,
        }),
      ),
    );
  }

  /**
   * Registra una superficie externa (orbe Tauri por WS) para que reciba los
   * mensajes core→webview. Devuelve un disposer para retirarla al desconectar.
   */
  addExternalSink(sink: ExternalWebviewSink): () => void {
    this.externalSinks.add(sink);
    return () => {
      this.externalSinks.delete(sink);
    };
  }

  /**
   * Procesa un mensaje entrante de una superficie externa (orbe). Responde solo
   * a esa superficie, reutilizando exactamente los mismos handlers que el sidebar.
   */
  handleExternalMessage(
    msg: Message,
    respond: ExternalWebviewSink,
  ): Promise<void> {
    return this.handleIncomingMessage(msg, (data) =>
      respond({
        messageType: msg.messageType,
        data,
        messageId: msg.messageId,
      }),
    );
  }

  constructor() {}

  invoke<T extends keyof FromWebviewProtocol>(
    messageType: T,
    data: FromWebviewProtocol[T][0],
    messageId?: string,
  ): FromWebviewProtocol[T][1] {
    throw new Error("Method not implemented.");
  }

  onError(handler: (message: Message, error: Error) => void): void {
    throw new Error("Method not implemented.");
  }

  public request<T extends keyof ToWebviewProtocol>(
    messageType: T,
    data: ToWebviewProtocol[T][0],
    retry: boolean = true,
  ): Promise<ToWebviewProtocol[T][1]> {
    const messageId = uuidv4();
    return new Promise(async (resolve) => {
      if (retry) {
        let i = 0;
        while (!this.webview) {
          if (i >= 10) {
            resolve(undefined);
            return;
          } else {
            await new Promise((res) => setTimeout(res, i >= 5 ? 1000 : 500));
            i++;
          }
        }
      }

      this.send(messageType, data, messageId);

      if (this.webview) {
        const disposable = this.webview.onDidReceiveMessage(
          (msg: Message<ToWebviewProtocol[T][1]>) => {
            if (msg.messageId === messageId) {
              resolve(msg.data);
              disposable?.dispose();
            }
          },
        );
      } else if (!retry) {
        resolve(undefined);
      }
    });
  }
}
