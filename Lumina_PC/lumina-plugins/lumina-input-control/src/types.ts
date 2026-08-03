/**
 * Lumina Input Control — shared types.
 *
 * Governing principle: every tool returns a discriminated result so the
 * agent can react to "needs_confirmation" without guessing from prose.
 * The allowlist decision lives in `gatekeeper.ts` and the result is
 * carried back here verbatim.
 */

export type ActionDecision =
  | { kind: "allow"; processName: string }
  | { kind: "needs_confirmation"; processName: string; reason: string }
  | { kind: "deny"; processName: string; reason: string };

export type InputActionKind =
  | "focus_window"
  | "type"
  | "hotkey"
  | "mouse_click";

export type AuditRecord = {
  readonly id: string;
  readonly atISO: string;
  readonly kind: InputActionKind;
  readonly decision: ActionDecision["kind"];
  readonly processName: string;
  readonly summary: string;
  readonly ok: boolean;
  readonly error: string | null;
};

export type InputResult =
  | {
      readonly ok: true;
      readonly action: InputActionKind;
      readonly processName: string;
      readonly auditId: string;
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly action: InputActionKind;
      readonly reason: "needs_confirmation" | "denied" | "failed";
      readonly processName: string | null;
      readonly message: string;
      readonly auditId: string | null;
    };
