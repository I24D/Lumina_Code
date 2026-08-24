import { RUNTIME_API_OPERATIONS } from "./generated/runtimeOperations.generated.js";
import type { RuntimeEvent } from "./runtimeEvents.js";
import type { runtimeOpenApiDocument } from "./runtimeOpenApi.js";

export type RuntimeOpenApiDocument = typeof runtimeOpenApiDocument;

export interface RuntimeHealth {
  status: "ok";
  apiVersion: string;
  sessionId: string;
}

export interface RuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** Typed client for the operations defined by the runtime OpenAPI contract. */
export class LuminaRuntimeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: RuntimeClientOptions) {
    this.baseUrl = `${options.baseUrl.replace(/\/$/, "")}/api/v1`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Runtime API ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  }

  getHealth(): Promise<RuntimeHealth> {
    return this.request(RUNTIME_API_OPERATIONS.getHealth.path);
  }

  getState<T = unknown>(): Promise<T> {
    return this.request(RUNTIME_API_OPERATIONS.getState.path);
  }

  listChildSessions<T = unknown>(parentSessionId: string): Promise<T[]> {
    const operationPath = RUNTIME_API_OPERATIONS.listChildSessions.path.replace(
      "{id}",
      encodeURIComponent(parentSessionId),
    );
    return this.request(operationPath);
  }

  cancelChildSession(
    sessionId: string,
  ): Promise<{ success: true; sessionId: string }> {
    const operationPath =
      RUNTIME_API_OPERATIONS.cancelChildSession.path.replace(
        "{id}",
        encodeURIComponent(sessionId),
      );
    return this.request(operationPath, { method: "POST" });
  }

  retryChildSession<T = unknown>(sessionId: string): Promise<T> {
    const operationPath = RUNTIME_API_OPERATIONS.retryChildSession.path.replace(
      "{id}",
      encodeURIComponent(sessionId),
    );
    return this.request(operationPath, { method: "POST" });
  }

  queueMessage(message: string): Promise<{ queued: true; position: number }> {
    return this.request(RUNTIME_API_OPERATIONS.queueMessage.path, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  resolvePermission(
    requestId: string,
    approved: boolean,
  ): Promise<{ success: true; approved: boolean }> {
    return this.request(RUNTIME_API_OPERATIONS.resolvePermission.path, {
      method: "POST",
      body: JSON.stringify({ requestId, approved }),
    });
  }

  pause(): Promise<{ success: boolean; message: string }> {
    return this.request(RUNTIME_API_OPERATIONS.pauseRun.path, {
      method: "POST",
    });
  }

  getDiff(): Promise<{ diff: string }> {
    return this.request(RUNTIME_API_OPERATIONS.getDiff.path);
  }

  eventUrl(): string {
    return `${this.baseUrl}${RUNTIME_API_OPERATIONS.streamEvents.path}`;
  }

  parseEvent(data: string): RuntimeEvent {
    return JSON.parse(data) as RuntimeEvent;
  }
}
