export type PlanStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type PlanStep = {
  id: string;
  title: string;
  tool?: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  verify?: string;
  status?: PlanStepStatus;
  attempts?: number;
  error?: string;
};

export type TaskPlan = {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
};

export type RetryPolicy = {
  maxRetries: number;
  backoffMs: number;
};

export type PlanExecutionEvent = {
  planId: string;
  stepId?: string;
  type: "plan_started" | "step_started" | "step_succeeded" | "step_failed" | "plan_completed" | "plan_failed";
  message: string;
  createdAt: string;
};

export type ToolExecutor = (step: PlanStep, plan: TaskPlan) => Promise<{
  ok: boolean;
  output?: unknown;
  error?: string;
}>;
