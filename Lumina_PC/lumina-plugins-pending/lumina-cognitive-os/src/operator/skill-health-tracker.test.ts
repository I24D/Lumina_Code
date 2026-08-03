import { describe, expect, it, vi } from "vitest";
import { SkillHealthTracker } from "./skill-health-tracker.js";

describe("SkillHealthTracker", () => {
  it("flags a skill after threshold consecutive failures", () => {
    const flagged: string[] = [];
    const toasts: string[] = [];
    const t = new SkillHealthTracker({
      failureThreshold: 3,
      onFlag: (e) => flagged.push(e.skillName),
      notifyToast: (m) => toasts.push(m),
    });
    for (let i = 0; i < 2; i++) {
      const e = t.record({ skillName: "learned-spotify-play", ok: false, verified: false, runId: "r", iteration: i });
      expect(e.flagged).toBe(false);
    }
    const third = t.record({ skillName: "learned-spotify-play", ok: false, verified: false, runId: "r", iteration: 3 });
    expect(third.flagged).toBe(true);
    expect(third.consecutiveFailures).toBe(3);
    expect(flagged).toEqual(["learned-spotify-play"]);
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("learned-spotify-play");
  });

  it("does NOT flag again once already flagged (no toast spam)", () => {
    const toasts: string[] = [];
    const t = new SkillHealthTracker({ failureThreshold: 2, notifyToast: (m) => toasts.push(m) });
    t.record({ skillName: "learned-x", ok: false, verified: false, runId: "r", iteration: 1 });
    t.record({ skillName: "learned-x", ok: false, verified: false, runId: "r", iteration: 2 });
    t.record({ skillName: "learned-x", ok: false, verified: false, runId: "r", iteration: 3 });
    t.record({ skillName: "learned-x", ok: false, verified: false, runId: "r", iteration: 4 });
    expect(toasts.length).toBe(1);
  });

  it("a success resets the streak AND clears the flag", () => {
    const t = new SkillHealthTracker({ failureThreshold: 2 });
    t.record({ skillName: "learned-y", ok: false, verified: false, runId: "r", iteration: 1 });
    t.record({ skillName: "learned-y", ok: false, verified: false, runId: "r", iteration: 2 });
    const flagged = t.snapshot({ flaggedOnly: true });
    expect(flagged).toHaveLength(1);
    t.record({ skillName: "learned-y", ok: true, verified: true, runId: "r", iteration: 3 });
    const afterSuccess = t.snapshot({ flaggedOnly: true });
    expect(afterSuccess).toHaveLength(0);
  });

  it("treats verified=null as a success (no check done)", () => {
    const t = new SkillHealthTracker({ failureThreshold: 2 });
    const e = t.record({ skillName: "learned-z", ok: true, verified: null, runId: "r", iteration: 1 });
    expect(e.consecutiveFailures).toBe(0);
    expect(e.totalUses).toBe(1);
  });

  it("reset() forgets a skill entirely", () => {
    const t = new SkillHealthTracker({ failureThreshold: 1 });
    t.record({ skillName: "learned-w", ok: false, verified: false, runId: "r", iteration: 1 });
    expect(t.snapshot()).toHaveLength(1);
    expect(t.reset("learned-w")).toBe(true);
    expect(t.snapshot()).toHaveLength(0);
  });
});
