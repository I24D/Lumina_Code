import { PlanExecutionEvent, TaskPlan } from "./types.js";

export class ProgressTracker {
  private readonly events: PlanExecutionEvent[] = [];

  record(event: Omit<PlanExecutionEvent, "createdAt">): PlanExecutionEvent {
    const completed = {
      ...event,
      createdAt: new Date().toISOString(),
    };
    this.events.push(completed);
    return completed;
  }

  percent(plan: TaskPlan): number {
    if (plan.steps.length === 0) {
      return 0;
    }
    const complete = plan.steps.filter((step) => step.status === "succeeded" || step.status === "skipped").length;
    return Math.round((complete / plan.steps.length) * 100);
  }

  listEvents(planId?: string): PlanExecutionEvent[] {
    return planId ? this.events.filter((event) => event.planId === planId) : [...this.events];
  }
}
