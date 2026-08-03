/**
 * awareness-tool.ts — Tools:
 *   lumina_awareness_snapshot   — synchronous full snapshot
 *   lumina_awareness_subscribe  — returns the most recent N events from the bus
 *
 * Voice flow: "Lumina, ¿cómo está mi PC?" → snapshot tool.
 *             "Lumina, ¿qué cambió en la última hora?" → subscribe tool.
 */
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { AwarenessEventBus } from "./event-bus.js";
import { readEnvironmentSnapshot, type AwarenessPoller } from "./snapshot.js";

export function createAwarenessSnapshotTool(poller: AwarenessPoller): AnyAgentTool {
  return {
    name: "lumina_awareness_snapshot",
    label: "Lumina Awareness Snapshot",
    description:
      "Returns a unified snapshot of the local environment: CPU, RAM, GPU(s), battery, disks (physical and volumes), " +
      "connected cameras/microphones/Bluetooth, monitors with bounds, network status (online/latency/SSID profile). " +
      "Use this whenever the user asks how the computer is doing, or before scheduling heavy work.",
    parameters: Type.Object({
      fresh: Type.Optional(
        Type.Boolean({
          description: "If true, force a new poll instead of returning the cached snapshot.",
        }),
      ),
    }),
    async execute(_id, params) {
      const fresh = params.fresh === true;
      const snap = fresh ? await readEnvironmentSnapshot() : poller.current() ?? (await readEnvironmentSnapshot());
      return jsonResult({ ok: true, snapshot: snap });
    },
  };
}

export function createAwarenessSubscribeTool(bus: AwarenessEventBus): AnyAgentTool {
  return {
    name: "lumina_awareness_subscribe",
    label: "Lumina Awareness Subscribe",
    description:
      "Returns the most recent environment-change events (battery dropped, network went offline, disk low, " +
      "monitor added, etc). Use this to react to what changed instead of polling the snapshot.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 128, default: 32 }),
      ),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 32;
      return jsonResult({ ok: true, events: bus.recentEvents(limit) });
    },
  };
}
