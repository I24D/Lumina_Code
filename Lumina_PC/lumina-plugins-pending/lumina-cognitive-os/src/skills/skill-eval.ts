/**
 * skill-eval.ts — Track success rate / latency for learned skills.
 *
 * Each replay run for a learned skill writes a row to a per-skill JSONL
 * file at <skillsDir>/<skillId>/eval/runs.jsonl. The eval helpers read
 * back this log to compute success rate over the last N runs.
 *
 * Why a separate file: SKILL.md is the public contract; eval data is
 * private to Lumina and tends to grow. Keeping them separate avoids
 * accidentally publishing eval stats with the skill.
 */
import fs from "node:fs";
import path from "node:path";

export type SkillEvalRun = {
  readonly atISO: string;
  readonly runId: string;
  readonly status: "done" | "aborted" | "error";
  readonly stepCount: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly verifyFailed: number;
  readonly avgLatencyMs: number;
  readonly strategy: string;
  readonly mode: string;
};

export type SkillEvalStats = {
  readonly skillId: string;
  readonly runs: number;
  readonly successRate: number;
  readonly recentRuns: ReadonlyArray<SkillEvalRun>;
  readonly avgLatencyMs: number;
};

export class SkillEvalStore {
  private readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  recordRun(skillId: string, run: SkillEvalRun): void {
    const dir = path.join(this.skillsDir, skillId, "eval");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "runs.jsonl"), JSON.stringify(run) + "\n", "utf8");
    } catch {
      /* best-effort */
    }
  }

  stats(skillId: string, lastN = 20): SkillEvalStats {
    const file = path.join(this.skillsDir, skillId, "eval", "runs.jsonl");
    if (!fs.existsSync(file)) {
      return { skillId, runs: 0, successRate: 0, recentRuns: [], avgLatencyMs: 0 };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { skillId, runs: 0, successRate: 0, recentRuns: [], avgLatencyMs: 0 };
    }
    const rows: SkillEvalRun[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as SkillEvalRun);
      } catch {
        /* skip corrupt */
      }
    }
    const recent = rows.slice(-lastN);
    if (recent.length === 0) {
      return { skillId, runs: 0, successRate: 0, recentRuns: [], avgLatencyMs: 0 };
    }
    const successes = recent.filter((r) => r.status === "done" && r.failed === 0).length;
    const avgLatency = recent.reduce((acc, r) => acc + r.avgLatencyMs, 0) / recent.length;
    return {
      skillId,
      runs: recent.length,
      successRate: successes / recent.length,
      recentRuns: recent.slice().reverse(),
      avgLatencyMs: Math.round(avgLatency),
    };
  }
}
