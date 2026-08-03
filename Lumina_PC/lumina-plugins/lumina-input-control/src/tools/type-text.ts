/**
 * Tool: lumina_input_type
 *
 * Types a literal string into the currently focused window. The active
 * process is checked against the allowlist before each call — even if
 * focus changed since the agent last called focus_window.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { readForegroundProcessName } from "../foreground.js";
import { typeText } from "../drivers/sendkeys.js";
import type { AuditLog } from "../audit-log.js";
import type { Gatekeeper } from "../gatekeeper.js";
import type { RateLimiter } from "../rate-limit.js";

export function createTypeTool(
  gatekeeper: Gatekeeper,
  audit: AuditLog,
  limiter: RateLimiter,
  maxTypingChars: number,
): AnyAgentTool {
  return {
    name: "lumina_input_type",
    label: "Lumina Input — Type",
    description:
      "Types a literal string into the currently focused window. Newlines become Enter; tabs become Tab. Use lumina_input_focus_window first if you need to target a specific app. The foreground process is re-checked against the allowlist on EVERY call.",
    parameters: Type.Object({
      text: Type.String({
        description: `Text to type. Max ${maxTypingChars} characters.`,
        minLength: 1,
        maxLength: maxTypingChars,
      }),
    }),
    async execute(_toolCallId, params) {
      const input = params as { text: string };
      const rl = limiter.consume();
      if (!rl.ok) {
        return jsonResult({
          ok: false,
          action: "type",
          reason: "failed",
          message: `rate-limited, retry in ${rl.retryAfterMs ?? 0}ms`,
        });
      }
      const fg = await readForegroundProcessName();
      const decision = gatekeeper.decide(fg?.name ?? null);
      const truncatedSummary = input.text.slice(0, 60).replace(/\s+/g, " ");
      const summary = `type "${truncatedSummary}${input.text.length > 60 ? "…" : ""}"`;
      if (decision.kind !== "allow") {
        const rec = audit.record({
          kind: "type",
          decision,
          summary,
          ok: false,
          error: decision.kind === "deny" ? decision.reason : null,
        });
        return jsonResult({
          ok: false,
          action: "type",
          reason: decision.kind === "deny" ? "denied" : "needs_confirmation",
          message: decision.reason,
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      const r = await typeText(input.text);
      const rec = audit.record({
        kind: "type",
        decision,
        summary,
        ok: r.ok,
        error: r.error ?? null,
      });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          action: "type",
          reason: "failed",
          message: r.error ?? "typing failed",
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      return jsonResult({
        ok: true,
        action: "type",
        processName: decision.processName,
        detail: `${input.text.length} chars`,
        auditId: rec.id,
      });
    },
  };
}
