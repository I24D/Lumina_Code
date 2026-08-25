import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MemoryService } from "../memory/index.js";
import { MemoryPersistence } from "../memory/MemoryPersistence.js";
import type {
  ExperienceOutcome,
  ExperienceRecord,
  MemorySnapshot,
  VectorSearchResult,
} from "../memory/index.js";
import { TaskLedger } from "../planner/TaskLedger.js";
import type { LuminaTaskRecord } from "../planner/TaskLedger.js";

type ToolCallLike = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
};

type ToolContextItemLike = {
  name?: string;
  description?: string;
  content?: string;
};

type ToolResultLike = {
  contextItems?: ToolContextItemLike[];
  errorMessage?: string;
  errorReason?: string;
};

export type LuminaAssistantMemoryItem = {
  id: string;
  title: string;
  summary: string;
  severity?: "info" | "warning" | "critical";
};

export type LuminaAssistantToolState = {
  name: string;
  status: "ready" | "running" | "blocked";
  detail?: string;
};

export type LuminaAssistantTaskStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  kind?: LuminaTaskRecord["kind"];
  toolName?: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  detail?: string;
  error?: string;
};

export type LuminaAssistantSettingsState = {
  fullAccess: boolean;
  requireVerification: boolean;
  continuousVision: boolean;
};

export type LuminaAssistantState = {
  memory: LuminaAssistantMemoryItem[];
  tools: LuminaAssistantToolState[];
  steps: LuminaAssistantTaskStep[];
  settings: LuminaAssistantSettingsState;
  stateDir: string;
};

function taskStatusToStepStatus(
  status: LuminaTaskRecord["status"],
): LuminaAssistantTaskStep["status"] {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "cancelled":
    case "timed_out":
      return "skipped";
    case "failed":
      return "failed";
  }
}

function taskStatusToToolStatus(
  status: LuminaTaskRecord["status"],
): LuminaAssistantToolState["status"] {
  if (status === "running") {
    return "running";
  }
  if (status === "failed" || status === "timed_out") {
    return "blocked";
  }
  return "ready";
}

function summarizeToolResult(result: ToolResultLike): string {
  if (result.errorMessage) {
    return result.errorMessage;
  }

  const firstItem = result.contextItems?.[0];
  if (!firstItem) {
    return "Tool completed without context output.";
  }

  return (
    firstItem.description ??
    firstItem.name ??
    firstItem.content?.slice(0, 240) ??
    "Tool completed."
  );
}

function isTaskRecord(value: unknown): value is LuminaTaskRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<LuminaTaskRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.status === "string" &&
    typeof record.kind === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

export class LuminaAgentRuntime {
  readonly memoryService = new MemoryService();
  readonly taskLedger = new TaskLedger();

  private readonly stateDir =
    process.env.LUMINA_AGENT_STATE_DIR ??
    join(homedir(), ".lumina-code", "agent-state");
  private readonly experiencesPath = join(this.stateDir, "experiences.jsonl");
  private readonly memoryPath = join(this.stateDir, "memory.json");
  private readonly tasksPath = join(this.stateDir, "tasks.json");
  private readonly memoryPersistence = new MemoryPersistence(
    this.memoryPath,
    this.experiencesPath,
  );

  constructor() {
    this.loadState();
  }

  startToolCall(toolCall: ToolCallLike): void {
    this.taskLedger.startToolTask({
      id: toolCall.id,
      toolName: toolCall.function.name,
    });
    this.persistTasks();
  }

  finishToolCall(
    toolCall: ToolCallLike,
    result: ToolResultLike,
    durationMs: number,
  ): void {
    const summary = summarizeToolResult(result);
    const outcome: ExperienceOutcome = result.errorMessage
      ? "failure"
      : "success";

    if (result.errorMessage) {
      this.taskLedger.failTask(toolCall.id, result.errorMessage, durationMs);
    } else {
      this.taskLedger.completeTask(toolCall.id, summary, durationMs);
    }

    this.memoryService.logExperience({
      goal: `Tool call: ${toolCall.function.name}`,
      summary,
      outcome,
      toolNames: [toolCall.function.name],
      tags: ["tool-call", toolCall.function.name],
      error: result.errorMessage,
      durationMs,
      metadata: {
        toolCallId: toolCall.id,
        errorReason: result.errorReason,
      },
    });

    this.persistMemory();
    this.persistTasks();
  }

  failToolCall(
    toolCall: ToolCallLike,
    error: unknown,
    durationMs: number,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.taskLedger.failTask(toolCall.id, errorMessage, durationMs);

    this.memoryService.logExperience({
      goal: `Tool call: ${toolCall.function.name}`,
      summary: errorMessage,
      outcome: "failure",
      toolNames: [toolCall.function.name],
      tags: ["tool-call", toolCall.function.name, "critical"],
      error: errorMessage,
      durationMs,
      metadata: {
        toolCallId: toolCall.id,
      },
    });

    this.persistMemory();
    this.persistTasks();
  }

  getAssistantState(): LuminaAssistantState {
    const recentTasks = this.taskLedger.list({ limit: 20 }).reverse();
    const toolStates = new Map<string, LuminaAssistantToolState>();

    for (const task of recentTasks) {
      if (!task.toolName || toolStates.has(task.toolName)) {
        continue;
      }
      toolStates.set(task.toolName, {
        name: task.toolName,
        status: taskStatusToToolStatus(task.status),
        detail: task.progressSummary ?? task.error,
      });
    }

    const insights = this.memoryService
      .getInsights()
      .slice(-5)
      .reverse()
      .map<LuminaAssistantMemoryItem>((insight) => ({
        id: insight.id,
        title: insight.title,
        summary: insight.summary,
        severity: insight.severity,
      }));

    const experiences = this.memoryService.experienceLogger
      .list({ limit: 10 })
      .reverse()
      .map<LuminaAssistantMemoryItem>((record) => ({
        id: record.id,
        title: record.goal,
        summary: record.summary,
        severity: record.outcome === "failure" ? "warning" : "info",
      }));

    return {
      memory: [...insights, ...experiences].slice(0, 12),
      tools: Array.from(toolStates.values()),
      steps: recentTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: taskStatusToStepStatus(task.status),
        kind: task.kind,
        toolName: task.toolName,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        durationMs: task.durationMs,
        detail: task.progressSummary,
        error: task.error,
      })),
      settings: {
        fullAccess: false,
        requireVerification: true,
        continuousVision: true,
      },
      stateDir: this.stateDir,
    };
  }

  getMemorySnapshot(): MemorySnapshot {
    return this.memoryService.snapshot();
  }

  searchMemory(
    query: string,
    limit = 20,
  ): VectorSearchResult<ExperienceRecord>[] {
    return this.memoryService.searchExperiences(
      query.trim(),
      Math.max(1, Math.min(100, limit)),
    );
  }

  deleteMemory(id: string): MemorySnapshot {
    if (!this.memoryService.removeExperience(id)) {
      throw new Error("La experiencia de memoria no existe.");
    }
    this.persistMemory();
    return this.memoryService.snapshot();
  }

  clearMemory(): MemorySnapshot {
    this.memoryService.clear();
    this.persistMemory();
    return this.memoryService.snapshot();
  }

  replaceMemory(snapshot: MemorySnapshot): MemorySnapshot {
    this.memoryService.replace(snapshot);
    this.persistMemory();
    return this.memoryService.snapshot();
  }

  private loadState(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });

      if (existsSync(this.tasksPath)) {
        const parsed = JSON.parse(readFileSync(this.tasksPath, "utf8"));
        if (Array.isArray(parsed)) {
          this.taskLedger.hydrate(parsed.filter(isTaskRecord));
        }
      }

      const snapshot = this.memoryPersistence.load();
      this.memoryService.replace(snapshot);
      // Writes the versioned snapshot after importing the legacy JSONL file.
      this.persistMemory();
    } catch {
      // Runtime state must never block Continue startup.
    }
  }

  private persistTasks(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(
        this.tasksPath,
        JSON.stringify(this.taskLedger.snapshot(), null, 2),
        "utf8",
      );
    } catch {
      // Persistence is best-effort; tool execution should continue.
    }
  }

  private persistMemory(): void {
    try {
      this.memoryPersistence.save(this.memoryService.snapshot());
    } catch {
      // Persistence is best-effort; tool execution should continue.
    }
  }
}

export const luminaAgentRuntime = new LuminaAgentRuntime();
