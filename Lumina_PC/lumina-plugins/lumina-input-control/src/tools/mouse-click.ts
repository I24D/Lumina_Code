/**
 * Tool: lumina_input_mouse_click
 *
 * Single click at an absolute screen coordinate with the given button.
 * Useful for clicking on a known UI element. The foreground process is
 * the one currently AT that coordinate after a brief settle delay.
 */
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { readForegroundProcessName } from "../foreground.js";
import { clickAt, type MouseButton } from "../drivers/mouse.js";
import type { AuditLog } from "../audit-log.js";
import type { Gatekeeper } from "../gatekeeper.js";
import type { RateLimiter } from "../rate-limit.js";

export function createMouseClickTool(
  gatekeeper: Gatekeeper,
  audit: AuditLog,
  limiter: RateLimiter,
): AnyAgentTool {
  return {
    name: "lumina_input_mouse_click",
    label: "Lumina Input — Mouse Click",
    description:
      "Click at an absolute screen coordinate (physical pixels). The allowlist check runs against the foreground process at the time of the call — make sure the target app is focused first via lumina_input_focus_window.",
    parameters: Type.Object({
      x: Type.Integer({ description: "Screen X in physical pixels.", minimum: 0, maximum: 16_000 }),
      y: Type.Integer({ description: "Screen Y in physical pixels.", minimum: 0, maximum: 16_000 }),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
          description: "Which button. Default left.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const input = params as { x: number; y: number; button?: MouseButton };
      const button: MouseButton = input.button ?? "left";
      const rl = limiter.consume();
      if (!rl.ok) {
        return jsonResult({
          ok: false,
          action: "mouse_click",
          reason: "failed",
          message: `rate-limited, retry in ${rl.retryAfterMs ?? 0}ms`,
        });
      }
      const fg = await readForegroundProcessName();
      const decision = gatekeeper.decide(fg?.name ?? null);
      const summary = `${button} click at (${input.x}, ${input.y})`;
      if (decision.kind !== "allow") {
        const rec = audit.record({
          kind: "mouse_click",
          decision,
          summary,
          ok: false,
          error: decision.kind === "deny" ? decision.reason : null,
        });
        return jsonResult({
          ok: false,
          action: "mouse_click",
          reason: decision.kind === "deny" ? "denied" : "needs_confirmation",
          message: decision.reason,
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      const r = await clickAt(input.x, input.y, button);
      const rec = audit.record({
        kind: "mouse_click",
        decision,
        summary,
        ok: r.ok,
        error: r.error ?? null,
      });
      if (!r.ok) {
        return jsonResult({
          ok: false,
          action: "mouse_click",
          reason: "failed",
          message: r.error ?? "click failed",
          processName: decision.processName,
          auditId: rec.id,
        });
      }
      return jsonResult({
        ok: true,
        action: "mouse_click",
        processName: decision.processName,
        detail: summary,
        auditId: rec.id,
      });
    },
  };
}
