import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeNextRun,
  ScheduledTaskService,
} from "./ScheduledTaskService.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("computeNextRun", () => {
  it("calculates daily and weekly local schedules", () => {
    const from = new Date(2026, 7, 23, 14, 30);
    expect(computeNextRun({ kind: "daily", time: "15:00" }, from)).toEqual(
      new Date(2026, 7, 23, 15, 0),
    );
    expect(computeNextRun({ kind: "daily", time: "14:00" }, from)).toEqual(
      new Date(2026, 7, 24, 14, 0),
    );
    const monday = new Date(2026, 7, 24, 9, 0);
    expect(
      computeNextRun({ kind: "weekly", time: "10:30", days: [1] }, monday),
    ).toEqual(new Date(2026, 7, 24, 10, 30));
  });

  it("supports five-field cron with lists, ranges and steps", () => {
    const from = new Date(2026, 7, 23, 10, 1);
    expect(
      computeNextRun({ kind: "cron", expression: "*/15 9-17 * * 1-5" }, from),
    ).toEqual(new Date(2026, 7, 24, 9, 0));
    expect(() =>
      computeNextRun({ kind: "cron", expression: "invalid" }, from),
    ).toThrow(/cinco campos/i);
  });
});

describe("ScheduledTaskService", () => {
  it("persists due work, claims it once and records completion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-scheduler-"));
    tempDirs.push(dir);
    const storagePath = path.join(dir, "tasks.json");
    let now = new Date("2030-01-01T10:00:00.000Z");
    const service = new ScheduledTaskService({
      storagePath,
      now: () => now,
      startTimers: false,
    });
    const task = service.create({
      name: "Morning checks",
      prompt: "Run the test suite",
      enabled: true,
      schedule: { kind: "once", at: "2030-01-01T10:05:00.000Z" },
      runAsGoal: true,
      maxTurns: 8,
    });
    expect(task.nextRunAt).toBe("2030-01-01T10:05:00.000Z");

    now = new Date("2030-01-01T10:06:00.000Z");
    expect(service.list().runs[0]).toMatchObject({
      taskId: task.id,
      status: "queued",
    });
    const claimed = service.claimDue();
    expect(claimed?.run.status).toBe("running");
    expect(service.claimDue()).toBeUndefined();

    service.reportRun({
      runId: claimed!.run.id,
      status: "completed",
      sessionId: "session-1",
    });
    service.dispose();

    const reloaded = new ScheduledTaskService({
      storagePath,
      now: () => now,
      startTimers: false,
    });
    expect(reloaded.list().runs[0]).toMatchObject({
      status: "completed",
      sessionId: "session-1",
    });
    expect(reloaded.list().tasks[0].enabled).toBe(false);
    reloaded.dispose();
  });

  it("validates prompts and weekly days before writing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-scheduler-"));
    tempDirs.push(dir);
    const service = new ScheduledTaskService({
      storagePath: path.join(dir, "tasks.json"),
      startTimers: false,
    });
    expect(() =>
      service.create({
        name: "Bad task",
        prompt: " ",
        enabled: true,
        schedule: { kind: "weekly", time: "10:00", days: [] },
        runAsGoal: false,
      }),
    ).toThrow(/prompt/i);
    service.dispose();
  });
});
