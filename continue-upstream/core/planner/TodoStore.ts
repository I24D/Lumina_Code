import {
  TodoItem,
  TodoSnapshot,
  TodoStatus,
  TodoWriteMode,
} from "./types.js";

/** A list longer than this stopped being a plan and became a backlog. */
export const MAX_TODO_ITEMS = 256;

/** Per-item cap. Anything longer belongs in the conversation, not the list. */
export const MAX_TODO_CONTENT_CHARS = 4_000;

const STATUSES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

/** Statuses that still represent outstanding work. */
const ACTIVE_STATUSES = new Set<TodoStatus>(["pending", "in_progress"]);

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.includes(value as TodoStatus);
}

function emptyCounts(): Record<TodoStatus, number> {
  return { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
}

/**
 * The task list the agent maintains while working.
 *
 * Ported from Hermes's todo tool, including its bounds, its replace/merge
 * semantics and its re-injection after context compression.
 *
 * Deliberately not persisted. A task list is scaffolding for one stretch of
 * work; writing it to disk would mean resurrecting a half-finished plan weeks
 * later, in a session whose context no longer supports it. What is worth
 * keeping from a solved task is a skill, and create_skill already does that.
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private activeSessionId: string | undefined;

  /**
   * Points the store at a conversation. Switching conversations clears the
   * list, because a plan only means anything against the messages that
   * produced it — carrying it into a different chat would show the user work
   * items that nothing in front of them explains.
   */
  setActiveSession(sessionId: string | undefined): void {
    if (sessionId === this.activeSessionId) {
      return;
    }
    this.activeSessionId = sessionId;
    this.items = [];
  }

  read(): TodoSnapshot {
    return this.snapshot();
  }

  clear(): void {
    this.items = [];
  }

  /**
   * Writes the list.
   *
   * Invalid entries are rejected rather than coerced: a todo with no id cannot
   * be updated later, and one with an unknown status cannot be counted, so
   * silently repairing either would produce a list that does not behave the
   * way the model believes it does.
   */
  write(
    input: unknown,
    mode: TodoWriteMode = "replace",
  ): { snapshot: TodoSnapshot; rejected: string[] } {
    if (!Array.isArray(input)) {
      throw new Error("todos must be an array of { id, content, status }.");
    }

    const rejected: string[] = [];
    const accepted: TodoItem[] = [];
    const seen = new Set<string>();

    for (const [index, raw] of input.entries()) {
      const item = raw as Partial<TodoItem> | null;
      if (!item || typeof item !== "object") {
        rejected.push(`#${index}: not an object`);
        continue;
      }
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const content =
        typeof item.content === "string" ? item.content.trim() : "";

      if (id === "") {
        rejected.push(`#${index}: missing id`);
        continue;
      }
      if (content === "") {
        rejected.push(`#${index} (${id}): missing content`);
        continue;
      }
      if (!isTodoStatus(item.status)) {
        rejected.push(
          `#${index} (${id}): status must be one of ${STATUSES.join(", ")}`,
        );
        continue;
      }
      if (seen.has(id)) {
        rejected.push(`#${index} (${id}): duplicate id`);
        continue;
      }

      seen.add(id);
      accepted.push({
        id,
        content: content.slice(0, MAX_TODO_CONTENT_CHARS),
        status: item.status,
      });
    }

    if (mode === "merge") {
      const merged = [...this.items];
      for (const item of accepted) {
        const existing = merged.findIndex((candidate) => candidate.id === item.id);
        if (existing === -1) {
          merged.push(item);
        } else {
          merged[existing] = item;
        }
      }
      this.items = merged.slice(0, MAX_TODO_ITEMS);
    } else {
      this.items = accepted.slice(0, MAX_TODO_ITEMS);
    }

    return { snapshot: this.snapshot(), rejected };
  }

  /**
   * The outstanding work, rendered for re-injection after the conversation is
   * compacted. Completed and cancelled items are left out: they are what the
   * summary already covers, while the open ones are what the model is about to
   * lose track of.
   *
   * Returns undefined when there is nothing outstanding, so callers can skip
   * adding an empty note to the summary.
   */
  formatForCompaction(): string | undefined {
    const active = this.items.filter((item) => ACTIVE_STATUSES.has(item.status));
    if (active.length === 0) {
      return undefined;
    }
    const lines = active.map(
      (item) =>
        `- [${item.status === "in_progress" ? "in progress" : "pending"}] ${item.content}`,
    );
    return [
      "[Your active task list was preserved across context compression]",
      ...lines,
    ].join("\n");
  }

  private snapshot(): TodoSnapshot {
    const counts = emptyCounts();
    for (const item of this.items) {
      counts[item.status] += 1;
    }
    return { items: [...this.items], counts };
  }
}

let sharedStore: TodoStore | undefined;

export function getTodoStore(): TodoStore {
  if (!sharedStore) {
    sharedStore = new TodoStore();
  }
  return sharedStore;
}
