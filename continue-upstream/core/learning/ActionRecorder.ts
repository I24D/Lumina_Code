import { RecordedAction } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ActionRecorder {
  private readonly actions: RecordedAction[] = [];

  record(action: Omit<RecordedAction, "id" | "createdAt">): RecordedAction {
    const recorded: RecordedAction = {
      ...action,
      id: createId("action"),
      createdAt: new Date().toISOString(),
    };
    this.actions.push(recorded);
    return recorded;
  }

  list(limit = this.actions.length): RecordedAction[] {
    return this.actions.slice(-limit);
  }

  clear(): void {
    this.actions.length = 0;
  }
}
