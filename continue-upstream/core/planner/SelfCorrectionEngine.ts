import { PlanStep } from "./types.js";

export class SelfCorrectionEngine {
  correct(step: PlanStep, error: string): PlanStep {
    return {
      ...step,
      status: "pending",
      error,
      title: `${step.title} (retry with verification)`,
      verify: step.verify ?? "Confirm the observable state before continuing.",
    };
  }
}
