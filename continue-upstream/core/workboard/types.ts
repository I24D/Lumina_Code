/** Browser-safe workboard contract shared by core, protocol and the React UI. */
export const WORKBOARD_COLUMNS = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;

export type WorkboardColumn = (typeof WORKBOARD_COLUMNS)[number];
export type WorkboardPriority = "low" | "normal" | "high" | "critical";

export interface WorkboardCard {
  id: string;
  title: string;
  description: string;
  column: WorkboardColumn;
  priority: WorkboardPriority;
  tags: string[];
  sessionId?: string;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkboardActivity {
  id: string;
  cardId: string;
  kind: "created" | "updated" | "moved" | "deleted";
  summary: string;
  fromColumn?: WorkboardColumn;
  toColumn?: WorkboardColumn;
  createdAt: string;
}

export interface WorkboardSnapshot {
  cards: WorkboardCard[];
  activity: WorkboardActivity[];
  counts: Record<WorkboardColumn, number>;
}

export interface WorkboardCardInput {
  title: string;
  description?: string;
  column?: WorkboardColumn;
  priority?: WorkboardPriority;
  tags?: string[];
  sessionId?: string;
  worktreePath?: string;
}
