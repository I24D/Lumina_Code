/**
 * policies.ts — Classification rules for the Risk Evaluation Engine.
 *
 * Each rule maps a (category, action, target) triple to one of the four
 * risk tiers. Rules are pure data — no I/O — so they're trivial to test
 * and to extend by the user via plugin config.
 *
 * Tiers (in increasing severity):
 *   SAFE      → execute without prompt
 *   WARNING   → execute but surface a one-line notice to the user
 *   HIGH_RISK → ask for explicit voice/typed confirmation
 *   CRITICAL  → ask twice, log, and refuse to batch with other actions
 */

export const RISK_TIERS = ["SAFE", "WARNING", "HIGH_RISK", "CRITICAL"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const RISK_CATEGORIES = [
  "read",
  "write",
  "exec",
  "network",
  "input",
  "system",
  "secret",
  "money",
  "communication",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type RiskRule = {
  readonly id: string;
  readonly category: RiskCategory;
  /** Optional substring/regex match on the action name (case-insensitive). */
  readonly actionMatch?: string | RegExp;
  /** Optional substring/regex match on the target path/URL/recipient. */
  readonly targetMatch?: string | RegExp;
  readonly tier: RiskTier;
  readonly reason: string;
};

/** Default ruleset. Ordered: first match wins. */
export const DEFAULT_RISK_RULES: ReadonlyArray<RiskRule> = [
  // ── CRITICAL ─────────────────────────────────────────────────────
  {
    id: "exec-rm-rf",
    category: "exec",
    actionMatch: /rm\s+-rf|Remove-Item.*-Recurse.*-Force|format\s+[a-z]:|del\s+\/f\s+\/s\s+\/q/i,
    tier: "CRITICAL",
    reason: "Recursive delete or disk format detected.",
  },
  {
    id: "exec-shutdown",
    category: "exec",
    actionMatch: /shutdown|Restart-Computer|Stop-Computer/i,
    tier: "CRITICAL",
    reason: "Shutdown/restart command.",
  },
  {
    id: "secret-leak",
    category: "secret",
    tier: "CRITICAL",
    reason: "Action touches secrets (.env, API key, token).",
  },
  {
    id: "money-payment",
    category: "money",
    tier: "CRITICAL",
    reason: "Payment / financial action.",
  },
  // ── HIGH_RISK ────────────────────────────────────────────────────
  {
    id: "write-system32",
    category: "write",
    targetMatch: /\\Windows\\System32|\\Program Files|\\ProgramData|\/etc\//i,
    tier: "HIGH_RISK",
    reason: "Write to a system directory.",
  },
  {
    id: "exec-elevation",
    category: "exec",
    actionMatch: /sudo|runas|Start-Process.*-Verb\s+RunAs/i,
    tier: "HIGH_RISK",
    reason: "Privilege elevation.",
  },
  {
    id: "exec-network-listen",
    category: "exec",
    actionMatch: /netcat|nc\s+-l|iptables|netsh\s+firewall/i,
    tier: "HIGH_RISK",
    reason: "Network listener / firewall change.",
  },
  {
    id: "input-key-press",
    category: "input",
    tier: "HIGH_RISK",
    reason: "Synthetic keyboard/mouse input on the user's machine.",
  },
  {
    id: "communication-broadcast",
    category: "communication",
    actionMatch: /broadcast|all[_-]?contacts|mass[_-]?send/i,
    tier: "HIGH_RISK",
    reason: "Mass communication.",
  },
  // ── WARNING ──────────────────────────────────────────────────────
  {
    id: "write-user-docs",
    category: "write",
    targetMatch: /Documents|Desktop|Downloads/i,
    tier: "WARNING",
    reason: "Writing in a user folder.",
  },
  {
    id: "network-external",
    category: "network",
    targetMatch: /^(?!https?:\/\/(localhost|127\.|10\.|192\.168\.|::1)).*$/i,
    tier: "SAFE",
    reason: "Outbound network request (allowed — Lumina may reach the network freely).",
  },
  {
    id: "communication-send",
    category: "communication",
    tier: "WARNING",
    reason: "Sending a message to a real contact.",
  },
  {
    id: "exec-shell",
    category: "exec",
    tier: "WARNING",
    reason: "Arbitrary shell execution.",
  },
  // ── SAFE ─────────────────────────────────────────────────────────
  {
    id: "read-default",
    category: "read",
    tier: "SAFE",
    reason: "Read-only access.",
  },
  {
    id: "system-default",
    category: "system",
    tier: "SAFE",
    reason: "System inspection.",
  },
];

export type EvaluateInput = {
  readonly category: RiskCategory;
  readonly action: string;
  readonly target?: string;
};

export type EvaluateOutput = {
  readonly tier: RiskTier;
  readonly reason: string;
  readonly ruleId: string;
  readonly requiresConfirmation: boolean;
  readonly requiresDoubleConfirmation: boolean;
  readonly mustAudit: boolean;
};

function matches(input: string, matcher: string | RegExp | undefined): boolean {
  if (matcher === undefined) return true;
  if (matcher instanceof RegExp) return matcher.test(input);
  return input.toLowerCase().includes(matcher.toLowerCase());
}

export function evaluateRisk(
  input: EvaluateInput,
  rules: ReadonlyArray<RiskRule> = DEFAULT_RISK_RULES,
): EvaluateOutput {
  for (const rule of rules) {
    if (rule.category !== input.category) continue;
    if (!matches(input.action, rule.actionMatch)) continue;
    if (!matches(input.target ?? "", rule.targetMatch)) continue;
    const tier = rule.tier;
    return {
      tier,
      reason: rule.reason,
      ruleId: rule.id,
      requiresConfirmation: tier === "HIGH_RISK" || tier === "CRITICAL",
      requiresDoubleConfirmation: tier === "CRITICAL",
      mustAudit: tier !== "SAFE",
    };
  }
  return {
    tier: "WARNING",
    reason: "No rule matched; defaulting to WARNING.",
    ruleId: "fallback",
    requiresConfirmation: false,
    requiresDoubleConfirmation: false,
    mustAudit: true,
  };
}
