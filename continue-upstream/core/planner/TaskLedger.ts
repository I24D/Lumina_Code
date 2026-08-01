export type LuminaTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type LuminaTaskRecord = {
  id: string;
  title: string;
  status: LuminaTaskStatus;
  kind: "tool" | "plan" | "agent";
  agentId?: string;
  toolName?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  progressSummary?: string;
  error?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class TaskLedger {
  private readonly tasks = new Map<string, LuminaTaskRecord>();

  hydrate(records: LuminaTaskRecord[]): void {
    this.tasks.clear();
    for (const record of records) {
      this.tasks.set(record.id, record);
    }
  }

  startToolTask(input: {
    id: string;
    toolName: string;
    title?: string;
  }): LuminaTaskRecord {
    const timestamp = nowIso();
    const existing = this.tasks.get(input.id);
    const record: LuminaTaskRecord = {
      ...existing,
      id: input.id,
      title: input.title ?? `Run ${input.toolName}`,
      status: "running",
      kind: "tool",
      toolName: input.toolName,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      startedAt: existing?.startedAt ?? timestamp,
      endedAt: undefined,
      error: undefined,
      progressSummary: `Executing ${input.toolName}`,
    };
    this.tasks.set(record.id, record);
    return record;
  }

  completeTask(
    id: string,
    progressSummary?: string,
    durationMs?: number,
  ): LuminaTaskRecord | undefined {
    return this.updateTask(id, {
      status: "completed",
      endedAt: nowIso(),
      durationMs,
      progressSummary,
      error: undefined,
    });
  }

  failTask(
    id: string,
    error: string,
    durationMs?: number,
  ): LuminaTaskRecord | undefined {
    return this.updateTask(id, {
      status: "failed",
      endedAt: nowIso(),
      durationMs,
      progressSummary: "Tool failed",
      error,
    });
  }

  list(options: { limit?: number; status?: LuminaTaskStatus } = {}): LuminaTaskRecord[] {
    const records = Array.from(this.tasks.values()).filter((task) =>
      options.status ? task.status === options.status : true,
    );
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return records.slice(-(options.limit ?? records.length));
  }

  snapshot(): LuminaTaskRecord[] {
    return this.list();
  }

  private updateTask(
    id: string,
    patch: Partial<LuminaTaskRecord>,
  ): LuminaTaskRecord | undefined {
    const existing = this.tasks.get(id);
    if (!existing) {
      return undefined;
    }

    const record: LuminaTaskRecord = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    this.tasks.set(id, record);
    return record;
  }
}
