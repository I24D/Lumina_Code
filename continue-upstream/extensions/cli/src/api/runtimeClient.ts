import { RUNTIME_API_OPERATIONS } from "./generated/runtimeOperations.generated.js";
import type { RuntimeEvent } from "./runtimeEvents.js";
import type { runtimeOpenApiDocument } from "./runtimeOpenApi.js";

export type RuntimeOpenApiDocument = typeof runtimeOpenApiDocument;

export interface RuntimeHealth {
  status: "ok";
  apiVersion: string;
  sessionId: string;
  workingDirectory: string;
}

export interface RuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface RuntimeEventSubscriptionOptions {
  signal?: AbortSignal;
  onOpen?: () => void;
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

  getChildDiff(sessionId: string): Promise<{ diff: string; status: string }> {
    const operationPath = RUNTIME_API_OPERATIONS.getChildDiff.path.replace(
      "{id}",
      encodeURIComponent(sessionId),
    );
    return this.request(operationPath);
  }

  applyChildDiff(sessionId: string): Promise<{ applied: true; diff: string }> {
    const operationPath = RUNTIME_API_OPERATIONS.applyChildDiff.path.replace(
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

  /** Consume the versioned SSE stream until it closes or is aborted. */
  async subscribeEvents(
    listener: (event: RuntimeEvent) => void | Promise<void>,
    options: RuntimeEventSubscriptionOptions = {},
  ): Promise<void> {
    const response = await this.fetchImpl(this.eventUrl(), {
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Runtime API ${response.status}: ${body}`);
    }
    if (!response.body) {
      throw new Error("Runtime API event stream has no response body");
    }

    options.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) await listener(this.parseEvent(data));
      }

      if (done) break;
    }
  }
}
