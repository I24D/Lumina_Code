/**
 * Tests for SkillEvalStore.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillEvalStore } from "./skill-eval.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-eval-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("SkillEvalStore", () => {
  it("returns zero stats when no runs", () => {
    const s = new SkillEvalStore(tmpDir);
    const stats = s.stats("anyone");
    expect(stats.runs).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.recentRuns).toEqual([]);
  });

  it("records and reads runs", () => {
    const s = new SkillEvalStore(tmpDir);
    s.recordRun("learned-test", {
      atISO: "2026-06-28T10:00:00Z",
      runId: "r1",
      status: "done",
      stepCount: 5,
      dispatched: 5,
      failed: 0,
      verifyFailed: 0,
      avgLatencyMs: 100,
      strategy: "hybrid",
      mode: "production",
    });
    s.recordRun("learned-test", {
      atISO: "2026-06-28T10:01:00Z",
      runId: "r2",
      status: "error",
      stepCount: 3,
      dispatched: 2,
      failed: 1,
      verifyFailed: 0,
      avgLatencyMs: 200,
      strategy: "hybrid",
      mode: "production",
    });
    const stats = s.stats("learned-test");
    expect(stats.runs).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.recentRuns[0]!.runId).toBe("r2");
    expect(stats.avgLatencyMs).toBe(150);
  });

  it("respects lastN windowing", () => {
    const s = new SkillEvalStore(tmpDir);
    for (let i = 0; i < 30; i++) {
      s.recordRun("learned-window", {
        atISO: new Date(2026, 5, 28, 10, i).toISOString(),
        runId: `r${i}`,
        status: i % 3 === 0 ? "error" : "done",
        stepCount: 1,
        dispatched: 1,
        failed: i % 3 === 0 ? 1 : 0,
        verifyFailed: 0,
        avgLatencyMs: 50,
        strategy: "hybrid",
        mode: "simulate",
      });
    }
    const stats = s.stats("learned-window", 5);
    expect(stats.runs).toBe(5);
  });

  it("survives a corrupt jsonl line", () => {
    const s = new SkillEvalStore(tmpDir);
    const dir = path.join(tmpDir, "broken", "eval");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "runs.jsonl"),
      '{"runId":"r1","atISO":"2026","status":"done","stepCount":1,"dispatched":1,"failed":0,"verifyFailed":0,"avgLatencyMs":1,"strategy":"x","mode":"x"}\n' +
        "NOT-JSON\n" +
        '{"runId":"r2","atISO":"2026","status":"done","stepCount":1,"dispatched":1,"failed":0,"verifyFailed":0,"avgLatencyMs":2,"strategy":"x","mode":"x"}\n',
      "utf8",
    );
    const stats = s.stats("broken");
    expect(stats.runs).toBe(2);
  });
});
