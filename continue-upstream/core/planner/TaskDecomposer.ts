import { PlanStep, TaskPlan } from "./types.js";

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class TaskDecomposer {
  decompose(goal: string, seedSteps: Array<Omit<PlanStep, "id">> = []): TaskPlan {
    const now = new Date().toISOString();
    const steps =
      seedSteps.length > 0
        ? seedSteps
        : [
            { title: "Understand goal and gather context" },
            { title: "Execute the smallest safe action" },
            { title: "Verify observable result before reporting" },
          ];

    return {
      id: createId("plan"),
      goal,
      createdAt: now,
      updatedAt: now,
      steps: steps.map((step, index) => ({
        ...step,
        id: createId(`step${index + 1}`),
        status: "pending",
        attempts: 0,
      })),
    };
  }
}
