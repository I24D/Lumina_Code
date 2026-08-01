import { TaskPlan } from "./types.js";

export class PlanValidator {
  validate(plan: TaskPlan): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!plan.goal.trim()) {
      errors.push("Plan goal is required.");
    }
    if (plan.steps.length === 0) {
      errors.push("Plan must include at least one step.");
    }

    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id.trim()) {
        errors.push("Every step needs an id.");
      }
      if (ids.has(step.id)) {
        errors.push(`Duplicate step id: ${step.id}`);
      }
      ids.add(step.id);
      if (!step.title.trim()) {
        errors.push(`Step ${step.id} needs a title.`);
      }
    }

    for (const step of plan.steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!ids.has(dependency)) {
          errors.push(`Step ${step.id} depends on missing step ${dependency}.`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }
}
