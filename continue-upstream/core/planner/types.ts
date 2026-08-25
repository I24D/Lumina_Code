/**
 * The agent's working task list.
 *
 * This is what the model keeps for itself while it works through something
 * multi-step: what it planned, what it is on now, what it already finished.
 * Distinct from TaskLedger, which records what the *runtime* did (one entry per
 * tool call, after the fact) — this is intent, that is history.
 */

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  /** Chosen by the model so it can address the same item again later. */
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * How a write combines with what is already there.
 *
 * `replace` is the default because the usual write is the model restating its
 * whole plan, and merging that would silently keep items it had decided to
 * drop. `merge` exists for the narrower case of ticking one item off without
 * resending the list.
 */
export type TodoWriteMode = "replace" | "merge";

export interface TodoSnapshot {
  /** Ordered: the first item is the highest priority. */
  items: TodoItem[];
  counts: Record<TodoStatus, number>;
}
