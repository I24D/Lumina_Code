import { ToolStep } from "./types.js";

export class ToolChainer {
  chain(steps: ToolStep[]): ToolStep[] {
    return steps.map((step, index) => ({
      ...step,
      verify: step.verify ?? (index === steps.length - 1 ? "Verify final observable result." : "Verify step result."),
    }));
  }
}
