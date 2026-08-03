/**
 * Tool: lumina_input_focus_window
 *
 * Brings a target application's window to the foreground so subsequent
 * typing/clicking targets it. Subject to the same allowlist as any other
 * input action — switching focus to an app off the allowlist requires
 * confirmation.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { focusByProcessName } from "../drivers/focus-window.js";
import type { AuditLog } from "../audit-log.js";
import type { Gatekeeper } from "../gatekeeper.js";
import type { RateLimiter } from "../rate-limit.js";

export function createFocusWindowTool(
  gatekeeper: Gatekeeper,
  audit: AuditLog,
  limiter: RateLimiter,
): AnyAgentTool {
  return {
    name: "lumina_input_focus_window",
    label: "Lumina Input — Focus Window",
    description:
      "Brings a target application's first visible window to the foreground. Use BEFORE typing or clicking so the input lands in the intended app. Subject to the allowlist: if the target process is not allowlisted, returns needs_confirmation and does NOT switch focus.",
    parameters: Type.Object({
      processName: Type.String({
        description: "Target process name without .exe, e.g. 'Code', 'chrome', 'WindowsTerminal'.",
        minLength: 1,
        maxLength: 64,
      }),
    }),
    async execute(_toolCallId, params) {
      const input = params as { processName: string };
      const rl = limiter.consume();
      if (!rl.ok) {
        return jsonResult({
          ok: false,
          action: "focus_window",
          reason: "failed",
          message: `rate-limited, retry in ${rl.retryAfterMs ?? 0}ms`,
        });
      }
      const decision = gatekeeper.decide(input.processName);
      if (decision.kind !== "allow") {
        const rec = audit.record({
          kind: "focus_window",
          decision,
          summary: `focus ${input.processName}`,
          ok: false,
          error: decision.kind === "deny" ? decision.reason : null,
        });
        return jsonResult({
          ok: false,
          action: "focus_window",
          reason: decision.kind === "deny" ? "denied" : "needs_confirmation",
          message: decision.kind === "deny" ? decision.reason : decision.reason,
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      const res = await focusByProcessName(input.processName);
      const rec = audit.record({
        kind: "focus_window",
        decision,
        summary: `focus ${input.processName}`,
        ok: res.ok,
        error: res.ok ? null : res.reason ?? "focus failed",
      });
      if (!res.ok) {
        return jsonResult({
          ok: false,
          action: "focus_window",
          reason: "failed",
          message: res.reason ?? "focus failed",
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      return jsonResult({
        ok: true,
        action: "focus_window",
        processName: decision.processName,
        detail: res.title ?? "",
        auditId: rec.id,
      });
    },
  };
}
