/**
 * risk-engine.ts — Stateful wrapper around the pure evaluateRisk policy.
 *
 * Adds:
 *   - In-memory audit log (last N decisions) for transparency.
 *   - Per-tier counters surfaced through getStats().
 *   - Optional listener callback so the UI / mascot can react to HIGH/CRITICAL
 *     evaluations (turn the orb red, dim the panel, etc).
 */
import {
  DEFAULT_RISK_RULES,
  evaluateRisk,
  type EvaluateInput,
  type EvaluateOutput,
  type RiskRule,
  type RiskTier,
  RISK_TIERS,
} from "./policies.js";

export type RiskDecisionRecord = EvaluateOutput & {
  readonly input: EvaluateInput;
  readonly atISO: string;
};

export type RiskEngineListener = (decision: RiskDecisionRecord) => void;

const MAX_AUDIT = 256;

export class RiskEngine {
  private readonly audit: RiskDecisionRecord[] = [];
  private readonly listeners = new Set<RiskEngineListener>();
  private readonly counts: Record<RiskTier, number> = {
    SAFE: 0,
    WARNING: 0,
    HIGH_RISK: 0,
    CRITICAL: 0,
  };
  private readonly rules: ReadonlyArray<RiskRule>;

  constructor(rules: ReadonlyArray<RiskRule> = DEFAULT_RISK_RULES) {
    this.rules = rules;
  }

  evaluate(input: EvaluateInput): RiskDecisionRecord {
    const decision = evaluateRisk(input, this.rules);
    const record: RiskDecisionRecord = {
      ...decision,
      input,
      atISO: new Date().toISOString(),
    };
    this.counts[record.tier] += 1;
    this.audit.unshift(record);
    if (this.audit.length > MAX_AUDIT) {
      this.audit.length = MAX_AUDIT;
    }
    for (const l of this.listeners) {
      try {
        l(record);
      } catch {
        /* listener errors must never break the engine */
      }
    }
    return record;
  }

  on(listener: RiskEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(limit = 32): ReadonlyArray<RiskDecisionRecord> {
    return this.audit.slice(0, Math.max(1, Math.min(MAX_AUDIT, limit)));
  }

  getStats(): {
    readonly totals: Record<RiskTier, number>;
    readonly recentCount: number;
  } {
    return {
      totals: { ...this.counts },
      recentCount: this.audit.length,
    };
  }
}

export const ALL_RISK_TIERS = RISK_TIERS;
export type { EvaluateInput, EvaluateOutput, RiskTier };
