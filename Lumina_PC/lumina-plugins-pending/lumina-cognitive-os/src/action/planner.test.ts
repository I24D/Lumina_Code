/**
 * Tests for the Action Planner validator (Nivel 4).
 */
import { describe, expect, it } from "vitest";
import { validatePlan } from "./planner.js";

describe("validatePlan", () => {
  it("rejects plans without a goal", () => {
    const r = validatePlan({ steps: [{ toolName: "lumina_clipboard", description: "x" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects empty step lists", () => {
    const r = validatePlan({ goal: "x", steps: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown tool names", () => {
    const r = validatePlan({
      goal: "test",
      steps: [{ toolName: "lumina_does_not_exist", description: "boom" }],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed plan", () => {
    const r = validatePlan({
      goal: "open clipboard",
      steps: [{ toolName: "lumina_clipboard", description: "read", params: { action: "get" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.steps).toHaveLength(1);
      expect(r.plan.steps[0]?.id).toBe("step-1");
      expect(r.plan.stopOnError).toBe(true);
    }
  });

  it("respects stopOnError=false", () => {
    const r = validatePlan({
      goal: "best-effort sequence",
      stopOnError: false,
      steps: [{ toolName: "lumina_clipboard", description: "read" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.stopOnError).toBe(false);
  });
});
