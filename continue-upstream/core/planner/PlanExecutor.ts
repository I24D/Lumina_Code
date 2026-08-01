import { PlanValidator } from "./PlanValidator.js";
import { ProgressTracker } from "./ProgressTracker.js";
import { SelfCorrectionEngine } from "./SelfCorrectionEngine.js";
import { RetryPolicy, TaskPlan, ToolExecutor } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlanExecutor {
  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly progressTracker = new ProgressTracker(),
    private readonly validator = new PlanValidator(),
    private readonly selfCorrectionEngine = new SelfCorrectionEngine(),
  ) {}

  async execute(plan: TaskPlan, retryPolicy: RetryPolicy = { maxRetries: 2, backoffMs: 500 }): Promise<TaskPlan> {
    const validation = this.validator.validate(plan);
    if (!validation.ok) {
      throw new Error(validation.errors.join(" "));
    }

    this.progressTracker.record({
      planId: plan.id,
      type: "plan_started",
      message: plan.goal,
    });

    for (const step of plan.steps) {
      const unmetDependency = (step.dependsOn ?? []).find((id) => {
        const dependency = plan.steps.find((candidate) => candidate.id === id);
        return dependency?.status !== "succeeded";
      });
      if (unmetDependency) {
        step.status = "skipped";
        step.error = `Dependency not met: ${unmetDependency}`;
        continue;
      }

      let attempt = 0;
      while (attempt <= retryPolicy.maxRetries) {
        attempt += 1;
        step.attempts = attempt;
        step.status = "running";
        this.progressTracker.record({
          planId: plan.id,
          stepId: step.id,
          type: "step_started",
          message: step.title,
        });

        const result = await this.toolExecutor(step, plan);
        if (result.ok) {
          step.status = "succeeded";
          step.error = undefined;
          this.progressTracker.record({
            planId: plan.id,
            stepId: step.id,
            type: "step_succeeded",
            message: step.title,
          });
          break;
        }

        step.status = "failed";
        step.error = result.error ?? "Step failed";
        this.progressTracker.record({
          planId: plan.id,
          stepId: step.id,
          type: "step_failed",
          message: step.error,
        });

        if (attempt > retryPolicy.maxRetries) {
          this.progressTracker.record({
            planId: plan.id,
            type: "plan_failed",
            message: `Plan failed at ${step.title}`,
          });
          return plan;
        }

        Object.assign(step, this.selfCorrectionEngine.correct(step, step.error));
        await sleep(retryPolicy.backoffMs * attempt);
      }
    }

    plan.updatedAt = new Date().toISOString();
    this.progressTracker.record({
      planId: plan.id,
      type: "plan_completed",
      message: `${this.progressTracker.percent(plan)}% complete`,
    });
    return plan;
  }

  getProgressTracker(): ProgressTracker {
    return this.progressTracker;
  }
}
