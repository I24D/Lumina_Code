import { Message } from "core/protocol/messenger";
import { v4 as uuidv4 } from "uuid";

/**
 * Router gui<->core para el host standalone. Es el port de
 * `extensions/vscode/src/webviewProtocol.ts` SIN VS Code: aqui no hay un
 * `vscode.Webview`, solo "superficies externas" (los orbes Tauri conectados por
 * WebSocket via `OrbBridgeServer`). Mantiene exactamente el mismo shape de
 * mensajes `{messageType, data, messageId}`, asi que la gui reutilizada no nota
 * la diferencia y Start Talk + la delegacion al agente funcionan identicos.
 */
export type ExternalWebviewSink = (msg: Message) => void;

export class WebviewProtocolHost {
  /** Handlers registrados por el puente (pass-through webview->core, e IDE). */
  private listeners = new Map<string, ((message: Message) => any)[]>();

  /** Superficies externas (orbes) suscritas a los mensajes core->webview. */
  private externalSinks = new Set<ExternalWebviewSink>();

  /** Peticiones core->webview a la espera de respuesta, por messageId. */
  private pendingRequests = new Map<string, (data: any) => void>();

  /** Emite un mensaje core->webview a todas las superficies conectadas. */
  send(messageType: string, data: any, messageId?: string): string {
    const id = messageId ?? uuidv4();
    const msg: Message = { messageType, data, messageId: id };
    for (const sink of this.externalSinks) {
      try {
        sink(msg);
      } catch {
        // una superficie caida no debe tumbar al resto
      }
    }
    return id;
  }

  on(
    messageType: string,
    handler: (message: Message) => any,
  ): void {
    if (!this.listeners.has(messageType)) {
      this.listeners.set(messageType, []);
    }
    this.listeners.get(messageType)?.push(handler);
  }

  /** Registra un orbe para que reciba los mensajes core->webview. */
  addExternalSink(sink: ExternalWebviewSink): () => void {
    this.externalSinks.add(sink);
    return () => {
      this.externalSinks.delete(sink);
    };
  }

  /**
   * Procesa un mensaje entrante de un orbe. Si es la RESPUESTA a una peticion
   * core->webview pendiente, la resuelve; si no, corre los handlers y responde
   * solo a ese orbe (incluye streaming de generadores, igual que el original).
   */
  handleExternalMessage(msg: Message, respond: ExternalWebviewSink): Promise<void> {
    const pending = this.pendingRequests.get(msg.messageId);
    if (pending) {
      this.pendingRequests.delete(msg.messageId);
      pending(msg.data);
      return Promise.resolve();
    }
    return this.handleIncomingMessage(msg, (data) =>
      respond({ messageType: msg.messageType, data, messageId: msg.messageId }),
    );
  }

  private async handleIncomingMessage(
    msg: Message,
    respond: (data: any) => void,
  ): Promise<void> {
    if (!("messageType" in msg) || !("messageId" in msg)) {
      throw new Error(`Invalid webview protocol msg: ${JSON.stringify(msg)}`);
    }

    const handlers = this.listeners.get(msg.messageType) || [];
    for (const handler of handlers) {
      try {
        const response = await handler(msg);
        // Tipos generador (p.ej. llm/streamChat): se hace streaming.
        if (response && typeof response[Symbol.asyncIterator] === "function") {
          let next = await response.next();
          while (!next.done) {
            respond({ done: false, content: next.value, status: "success" });
            next = await response.next();
          }
          respond({ done: true, content: next.value, status: "success" });
        } else {
          respond({ done: true, content: response, status: "success" });
        }
      } catch (e: any) {
        let message = e?.message;
        respond({ done: true, error: message, status: "error" });
        console.error(
          `Error handling webview message ${msg.messageType}: ${e?.stack ?? e}`,
        );
      }
    }
  }

  /**
   * Peticion core->webview (pass-through inverso). Emite a los orbes y espera la
   * respuesta con el mismo messageId; si no hay orbe o tarda, resuelve undefined.
   */
  request(messageType: string, data: any): Promise<any> {
    if (this.externalSinks.size === 0) {
      return Promise.resolve(undefined);
    }
    const messageId = uuidv4();
    return new Promise((resolve) => {
      this.pendingRequests.set(messageId, resolve);
      this.send(messageType, data, messageId);
      setTimeout(() => {
        if (this.pendingRequests.delete(messageId)) {
          resolve(undefined);
        }
      }, 10_000);
    });
  }
}
