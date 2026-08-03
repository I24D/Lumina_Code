/**
 * Gatekeeper — single decision point for "is Lumina allowed to act here?"
 *
 * Inputs: foreground process name + the configured lists.
 * Outputs: `allow | needs_confirmation | deny`, with the reason embedded
 * so the audit log and the tool result can both quote it verbatim.
 *
 * Order of checks (each TERMINATES on the first match):
 *   1. Denylist  → always deny, even if also on the allowlist.
 *   2. Allowlist → allow.
 *   3. Default   → needs_confirmation (or deny if `confirmationMode=block`).
 *
 * The gatekeeper does NOT enforce anything by itself; tools call it,
 * carry its decision back to the agent, and refuse to act when the
 * decision is not "allow".
 */
import type { ActionDecision } from "./types.js";

export type GatekeeperConfig = {
  readonly appAllowlist: ReadonlyArray<string>;
  readonly denylistAlways: ReadonlyArray<string>;
  readonly confirmationMode: "block" | "log_only";
};

function normalize(name: string): string {
  return name.replace(/\.exe$/i, "").trim().toLowerCase();
}

export class Gatekeeper {
  private readonly allowSet: Set<string>;
  private readonly denySet: Set<string>;

  constructor(private readonly config: GatekeeperConfig) {
    this.allowSet = new Set(config.appAllowlist.map(normalize));
    this.denySet = new Set(config.denylistAlways.map(normalize));
  }

  decide(processName: string | null): ActionDecision {
    const proc = processName === null ? "" : normalize(processName);
    if (!proc) {
      return {
        kind: "deny",
        processName: "",
        reason: "could not identify the foreground process",
      };
    }
    if (this.denySet.has(proc)) {
      return {
        kind: "deny",
        processName: proc,
        reason: "process is in the hard denylist; no input is allowed even with confirmation",
      };
    }
    if (this.allowSet.has(proc)) {
      return { kind: "allow", processName: proc };
    }
    if (this.config.confirmationMode === "log_only") {
      return { kind: "allow", processName: proc };
    }
    return {
      kind: "needs_confirmation",
      processName: proc,
      reason: `process '${proc}' is not in the allowlist; ask the user before acting`,
    };
  }
}
