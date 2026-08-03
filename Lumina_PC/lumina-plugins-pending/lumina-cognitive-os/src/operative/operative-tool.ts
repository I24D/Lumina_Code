/**
 * operative-tool.ts — Agent tools to control the proactive daemon.
 *
 *   lumina_operative_status   — running + enabled rules + recent suggestions
 *   lumina_operative_enable   — start the daemon if stopped
 *   lumina_operative_disable  — stop it (no more proactive toasts)
 *   lumina_operative_reload   — re-read operative-rules.json
 *   lumina_operative_recent   — last N suggestions (without re-dispatching)
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { OperativeDaemon } from "./operative-daemon.js";

export function createOperativeStatusTool(daemon: OperativeDaemon): AnyAgentTool {
  return {
    name: "lumina_operative_status",
    label: "Lumina Operative — Status",
    description:
      "Returns whether the proactive daemon is running, how many rules are enabled, how many failed to " +
      "load, and the most recent suggestions emitted. Use this BEFORE proposing to enable/disable.",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({
        ok: true,
        status: daemon.status(),
        loadErrors: daemon.errors(),
      });
    },
  };
}

export function createOperativeEnableTool(daemon: OperativeDaemon): AnyAgentTool {
  return {
    name: "lumina_operative_enable",
    label: "Lumina Operative — Enable",
    description:
      "Starts the proactive daemon so Lumina watches environment events (battery, disk, CPU, RAM, " +
      "device plug/unplug, network state) and emits toast suggestions per the configured rules.",
    parameters: Type.Object({}),
    async execute() {
      daemon.start();
      return jsonResult({ ok: true, status: daemon.status() });
    },
  };
}

export function createOperativeDisableTool(daemon: OperativeDaemon): AnyAgentTool {
  return {
    name: "lumina_operative_disable",
    label: "Lumina Operative — Disable",
    description:
      "Stops the proactive daemon. Awareness keeps running; only the toast-emitting layer stops. Use " +
      "when the user says 'cállate', 'no me molestes ahorita', 'silencio', 'apaga el operative'.",
    parameters: Type.Object({}),
    async execute() {
      daemon.stop();
      return jsonResult({ ok: true, status: daemon.status() });
    },
  };
}

export function createOperativeReloadTool(daemon: OperativeDaemon): AnyAgentTool {
  return {
    name: "lumina_operative_reload",
    label: "Lumina Operative — Reload Rules",
    description:
      "Re-reads operative-rules.json from disk. Use after the user edits the rules file by hand. " +
      "Returns the new rule count and any parse errors.",
    parameters: Type.Object({}),
    async execute() {
      const set = daemon.reload();
      return jsonResult({
        ok: true,
        rulesPath: set.sourcePath,
        ruleCount: set.rules.length,
        errors: set.errors,
        status: daemon.status(),
      });
    },
  };
}

export function createOperativeRecentTool(daemon: OperativeDaemon): AnyAgentTool {
  return {
    name: "lumina_operative_recent",
    label: "Lumina Operative — Recent Suggestions",
    description:
      "Returns the N most recent proactive suggestions emitted by the daemon. Use when the user asks " +
      "'qué me has avisado', 'qué se te ha disparado', or to recap proactive activity for a window of time.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 32, default: 16 })),
    }),
    async execute(_id, params) {
      const list = daemon.recentSuggestions(params.limit ?? 16);
      return jsonResult({
        ok: true,
        count: list.length,
        suggestions: list.map((s) => ({
          ruleId: s.rule.id,
          atISO: s.atISO,
          title: s.title,
          message: s.message,
          severity: s.severity,
          eventKind: s.event.kind,
          proposedAction: s.proposedAction ?? null,
        })),
      });
    },
  };
}
