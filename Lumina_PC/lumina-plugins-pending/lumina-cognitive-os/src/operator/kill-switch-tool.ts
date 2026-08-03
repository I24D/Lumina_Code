/**
 * kill-switch-tool.ts — Agent/voice control over the global emergency stop (§9).
 *
 * `lumina_kill_switch` with action:
 *   - status : report whether the operator is frozen + hotkey process state.
 *   - engage : trip it now from software (same effect as the panic hotkey).
 *   - reset  : re-arm so the operator can run again (frozen state is sticky).
 *
 * The physical hotkey (kill_switch.py via KillSwitchProcess) trips the same
 * switch; this tool is the software-side twin so "para todo" by voice works
 * even if a keyboard is out of reach.
 */
import { Type } from "typebox";

import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import { killSwitch } from "./kill-switch.js";
import type { KillSwitchProcess } from "./kill-switch-process.js";

export type KillSwitchToolDeps = {
  /** Optional: the hotkey sidecar manager, to surface its status. */
  readonly process?: KillSwitchProcess;
};

export function createKillSwitchTool(deps: KillSwitchToolDeps = {}): AnyAgentTool {
  return {
    name: "lumina_kill_switch",
    label: "Lumina Kill Switch",
    description:
      "Parada de emergencia global del operador de PC. action='status' informa si está congelado " +
      "(y el estado del hotkey). action='engage' congela YA: el loop se aborta y ningún click/tecleo " +
      "llega al Bridge. action='reset' re-arma para volver a operar (el estado congelado es persistente, " +
      "no se limpia solo). El hotkey físico por defecto es Ctrl+Alt+K.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("status"), Type.Literal("engage"), Type.Literal("reset")],
        { default: "status", description: "status | engage | reset" },
      ),
      reason: Type.Optional(Type.String({ description: "Motivo al hacer engage (auditoría)." })),
    }),
    async execute(_id, raw) {
      const params = raw as { action?: "status" | "engage" | "reset"; reason?: string };
      const action = params.action ?? "status";
      let state = killSwitch.getState();
      if (action === "engage") {
        state = killSwitch.engage(params.reason?.trim() || "tool");
      } else if (action === "reset") {
        state = killSwitch.reset();
      }
      return jsonResult({
        ok: true,
        action,
        state,
        hotkey: deps.process?.getStatus() ?? null,
      });
    },
  };
}
