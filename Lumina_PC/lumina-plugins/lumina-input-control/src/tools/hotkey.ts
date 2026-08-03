/**
 * Tool: lumina_input_hotkey
 *
 * Sends a keyboard combo using SendKeys notation:
 *   ^ = Ctrl   % = Alt   + = Shift
 *   Examples:  ^c (Ctrl+C), %{F4} (Alt+F4), +{TAB} (Shift+Tab),
 *              ^+{HOME} (Ctrl+Shift+Home), {F5} (F5)
 *
 * Restricted to the foreground app's allowlist decision, same as typing.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { readForegroundProcessName } from "../foreground.js";
import { hotkeyCombo } from "../drivers/sendkeys.js";
import type { AuditLog } from "../audit-log.js";
import type { Gatekeeper } from "../gatekeeper.js";
import type { RateLimiter } from "../rate-limit.js";

const ALLOWED_COMBO_RE = /^[\^%+~()\w{} ]+$/;

export function createHotkeyTool(
  gatekeeper: Gatekeeper,
  audit: AuditLog,
  limiter: RateLimiter,
): AnyAgentTool {
  return {
    name: "lumina_input_hotkey",
    label: "Lumina Input — Hotkey",
    description:
      "Sends a keyboard shortcut using SendKeys notation: ^=Ctrl, %=Alt, +=Shift. Examples: '^c', '%{F4}', '+{TAB}', '^+{END}', '{F5}'. Subject to the foreground-process allowlist on every call.",
    parameters: Type.Object({
      combo: Type.String({
        description: "SendKeys combo. Limited to letters, digits, modifiers (^%+~), parens, braces and spaces.",
        minLength: 1,
        maxLength: 64,
        pattern: "^[\\^%+~()\\w{} ]+$",
      }),
    }),
    async execute(_toolCallId, params) {
      const input = params as { combo: string };
      if (!ALLOWED_COMBO_RE.test(input.combo)) {
        return jsonResult({
          ok: false,
          action: "hotkey",
          reason: "failed",
          message: "combo contains disallowed characters",
        });
      }
      const rl = limiter.consume();
      if (!rl.ok) {
        return jsonResult({
          ok: false,
          action: "hotkey",
          reason: "failed",
          message: `rate-limited, retry in ${rl.retryAfterMs ?? 0}ms`,
        });
      }
      const fg = await readForegroundProcessName();
      const decision = gatekeeper.decide(fg?.name ?? null);
      const summary = `hotkey ${input.combo}`;
      if (decision.kind !== "allow") {
        const rec = audit.record({
          kind: "hotkey",
          decision,
          summary,
          ok: false,
          error: decision.kind === "deny" ? decision.reason : null,
        });
        return jsonResult({
          ok: false,
          action: "hotkey",
          reason: decision.kind === "deny" ? "denied" : "needs_confirmation",
          message: decision.reason,
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      const r = await hotkeyCombo(input.combo);
      const rec = audit.record({
        kind: "hotkey",
        decision,
        summary,
        ok: r.ok,
        error: r.error ?? null,
      });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          action: "hotkey",
          reason: "failed",
          message: r.error ?? "hotkey failed",
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      return jsonResult({
        ok: true,
        action: "hotkey",
        processName: decision.processName,
        detail: input.combo,
        auditId: rec.id,
      });
    },
  };
}
