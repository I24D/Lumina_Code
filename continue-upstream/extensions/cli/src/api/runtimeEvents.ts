import { EventEmitter } from "node:events";

export const RUNTIME_EVENT_TYPES = [
  "runtime.ready",
  "state.changed",
  "message.queued",
  "run.started",
  "run.content",
  "run.tool.started",
  "run.tool.result",
  "run.tool.error",
  "run.completed",
  "run.failed",
  "run.paused",
  "permission.requested",
  "permission.resolved",
  "child.updated",
  "server.stopping",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface RuntimeEvent<T = unknown> {
  id: number;
  type: RuntimeEventType;
  timestamp: string;
  data: T;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

class RuntimeEventBus {
  private readonly emitter = new EventEmitter();
  private sequence = 0;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish<T>(type: RuntimeEventType, data: T): RuntimeEvent<T> {
    const event: RuntimeEvent<T> = {
      id: ++this.sequence,
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  resetForTests(): void {
    this.sequence = 0;
    this.emitter.removeAllListeners();
  }
}

export const runtimeEventBus = new RuntimeEventBus();
