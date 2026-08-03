/**
 * skill-health-tracker.ts — Self-healing for learned-* skills.
 *
 * When the PC Operator Loop dispatches a smart_click/_type whose `query`
 * targets a learned-* skill (e.g. "learned-spotify-play"), we track the
 * dispatch + verification outcome here. After K consecutive failures
 * (default 3), we emit a toast + log entry asking Dal to re-record.
 *
 * The tracker is in-memory (per gateway session). Successful uses reset
 * the counter so a skill that worked yesterday but failed once today
 * doesn't immediately get flagged.
 *
 * Why this lives separately from `SkillEvalStore`:
 *   - SkillEvalStore is durable JSONL on disk: long-term success rate.
 *   - SkillHealthTracker is short-term streak detection during a run.
 * Both feed back into the agent's decision, but with different SLAs.
 */
import type { ActionLogStore } from "../memory/action-log.js";

export type SkillHealthEntry = {
  readonly skillName: string;
  consecutiveFailures: number;
  lastFailureISO?: string;
  lastSuccessISO?: string;
  totalUses: number;
  totalFailures: number;
  flagged: boolean;
  flaggedAtISO?: string;
  lastRunId?: string;
};

export type SkillHealthSnapshot = ReadonlyArray<SkillHealthEntry>;

export type SkillHealthDeps = {
  readonly failureThreshold?: number;
  readonly onFlag?: (entry: SkillHealthEntry) => void;
  readonly log?: ActionLogStore | null;
  readonly notifyToast?: (msg: string) => void;
};

export class SkillHealthTracker {
  private readonly entries = new Map<string, SkillHealthEntry>();
  private readonly threshold: number;
  private readonly onFlag?: (entry: SkillHealthEntry) => void;
  private readonly log: ActionLogStore | null;
  private readonly notifyToast?: (msg: string) => void;

  constructor(deps: SkillHealthDeps = {}) {
    this.threshold = Math.max(1, deps.failureThreshold ?? 3);
    this.onFlag = deps.onFlag;
    this.log = deps.log ?? null;
    this.notifyToast = deps.notifyToast;
  }

  /**
   * Record one outcome from a `learned-*` skill invocation via PC Operator.
   * `ok` = dispatch succeeded; `verified` = post-action check confirmed change.
   * A step counts as a "real" failure when dispatch failed OR verification
   * explicitly returned false. Verification=null (no check) defaults to ok.
   */
  record(params: {
    skillName: string;
    ok: boolean;
    verified: boolean | null;
    runId: string;
    iteration: number;
  }): SkillHealthEntry {
    const skillName = params.skillName.trim().toLowerCase();
    if (!skillName) {
      // Defensive: never store empty names.
      return {
        skillName: "",
        consecutiveFailures: 0,
        totalUses: 0,
        totalFailures: 0,
        flagged: false,
      };
    }
    const entry =
      this.entries.get(skillName) ??
      ({
        skillName,
        consecutiveFailures: 0,
        totalUses: 0,
        totalFailures: 0,
        flagged: false,
      } satisfies SkillHealthEntry);

    entry.totalUses += 1;
    entry.lastRunId = params.runId;
    const isFailure = !params.ok || params.verified === false;

    if (isFailure) {
      entry.consecutiveFailures += 1;
      entry.totalFailures += 1;
      entry.lastFailureISO = new Date().toISOString();
      if (!entry.flagged && entry.consecutiveFailures >= this.threshold) {
        entry.flagged = true;
        entry.flaggedAtISO = entry.lastFailureISO;
        const message =
          `La skill aprendida "${skillName}" falló ${entry.consecutiveFailures} veces seguidas. ` +
          "Considera regrabarla con `lumina_recorder_start` — la UI puede haber cambiado.";
        this.notifyToast?.(message);
        this.log?.append({
          action: "pc_operator.skill_flagged",
          target: skillName,
          result: "warn",
          detail: message,
          source: "pc-operator-self-healing",
          extra: {
            consecutiveFailures: entry.consecutiveFailures,
            totalUses: entry.totalUses,
            totalFailures: entry.totalFailures,
            lastRunId: params.runId,
          },
        });
        this.onFlag?.(entry);
      }
    } else {
      // Success — reset the streak AND clear the flag (skill recovered).
      entry.consecutiveFailures = 0;
      entry.lastSuccessISO = new Date().toISOString();
      if (entry.flagged) {
        entry.flagged = false;
        this.log?.append({
          action: "pc_operator.skill_recovered",
          target: skillName,
          result: "ok",
          detail: `Skill "${skillName}" recuperada — ya no flaggeada.`,
          source: "pc-operator-self-healing",
        });
      }
    }

    this.entries.set(skillName, entry);
    return entry;
  }

  /** Returns all tracked skills, optionally limited to flagged ones. */
  snapshot(params: { flaggedOnly?: boolean } = {}): SkillHealthSnapshot {
    const all = Array.from(this.entries.values());
    if (params.flaggedOnly) return all.filter((e) => e.flagged);
    return all.sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
  }

  /** Reset the tracker for a single skill (e.g. after Dal re-records it). */
  reset(skillName: string): boolean {
    const key = skillName.trim().toLowerCase();
    return this.entries.delete(key);
  }
}
