/**
 * perception-tools.ts — Agent tools that expose the continuous perception
 * sidecar to Lumina (start/stop/pause/resume + recent + status + healthcheck).
 *
 * Subscription model: tools that want push notifications register via
 * `bus.on(listener)`. Voice/chat tools call `lumina_perception_recent` to
 * pull the last N events on demand instead.
 */
import { Type } from "typebox";
import {
  jsonResult,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecarJson } from "../shared/python.js";
import type { PerceptionBus, PerceptionProcess } from "./perception-process.js";

export type PerceptionToolDeps = {
  readonly process: PerceptionProcess;
  readonly bus: PerceptionBus;
};

export function createPerceptionStartTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_start",
    label: "Lumina Perception — Start",
    description:
      "Arranca el sidecar continuo de percepción: captura pantalla principal a N fps y emite eventos " +
      "cuando algo cambia (diff > threshold) o cuando cambia la foreground window. Idempotente: si ya " +
      "está corriendo devuelve { ok:false, error:'already_running' }. El sidecar requiere `pip install " +
      "mss pillow`. Usa `lumina_perception_health` antes para verificar dependencias.",
    parameters: Type.Object({
      fps: Type.Optional(Type.Number({ minimum: 0.5, maximum: 10, default: 2 })),
      threshold: Type.Optional(Type.Number({ minimum: 0.001, maximum: 0.5, default: 0.01 })),
    }),
    async execute(_id, raw) {
      const params = raw as { fps?: number; threshold?: number };
      if (typeof params.fps === "number") deps.process.setDesiredFps(params.fps);
      if (typeof params.threshold === "number") deps.process.setDesiredThreshold(params.threshold);
      const r = deps.process.start();
      const status = deps.process.getStatus();
      return jsonResult({ ...r, status });
    },
  };
}

export function createPerceptionStopTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_stop",
    label: "Lumina Perception — Stop",
    description:
      "Pide al sidecar de percepción que se apague (graceful via stdin command, fallback SIGTERM en 800ms). " +
      "Idempotente: si no estaba corriendo devuelve { ok:false, error:'not_running' }.",
    parameters: Type.Object({}),
    async execute() {
      const r = deps.process.shutdown();
      return jsonResult({ ...r, status: deps.process.getStatus() });
    },
  };
}

export function createPerceptionPauseTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_pause",
    label: "Lumina Perception — Pause",
    description:
      "Pausa la captura sin matar el sidecar. Útil cuando Dal va a escribir contraseñas (privacy) o " +
      "para ahorrar batería temporalmente. Reanuda con lumina_perception_resume.",
    parameters: Type.Object({}),
    async execute() {
      const r = deps.process.pause();
      return jsonResult({ ...r, status: deps.process.getStatus() });
    },
  };
}

export function createPerceptionResumeTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_resume",
    label: "Lumina Perception — Resume",
    description: "Reanuda la captura después de un pause. No-op si no estaba pausado.",
    parameters: Type.Object({}),
    async execute() {
      const r = deps.process.resume();
      return jsonResult({ ...r, status: deps.process.getStatus() });
    },
  };
}

export function createPerceptionTuneTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_tune",
    label: "Lumina Perception — Tune",
    description:
      "Ajusta fps (0.5–10) y/o threshold (0.001–0.5) del sidecar en caliente sin reiniciarlo. " +
      "Threshold más alto = menos eventos (solo cambios grandes). FPS más alto = más CPU pero detección " +
      "más rápida. Defaults: fps=2, threshold=0.01.",
    parameters: Type.Object({
      fps: Type.Optional(Type.Number({ minimum: 0.5, maximum: 10 })),
      threshold: Type.Optional(Type.Number({ minimum: 0.001, maximum: 0.5 })),
    }),
    async execute(_id, raw) {
      const params = raw as { fps?: number; threshold?: number };
      const ops: Array<{ kind: string; ok: boolean; error?: string }> = [];
      if (typeof params.fps === "number") {
        const r = deps.process.setFps(params.fps);
        ops.push({ kind: "set_fps", ...r });
      }
      if (typeof params.threshold === "number") {
        const r = deps.process.setThreshold(params.threshold);
        ops.push({ kind: "set_threshold", ...r });
      }
      return jsonResult({ ok: ops.every((o) => o.ok), ops, status: deps.process.getStatus() });
    },
  };
}

export function createPerceptionStatusTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_status",
    label: "Lumina Perception — Status",
    description: "Devuelve estado del sidecar (running, pid, fps, threshold, paused, eventCount, last event ISO).",
    parameters: Type.Object({}),
    async execute() {
      return jsonResult({ ok: true, status: deps.process.getStatus() });
    },
  };
}

export function createPerceptionRecentTool(deps: PerceptionToolDeps): AnyAgentTool {
  return {
    name: "lumina_perception_recent",
    label: "Lumina Perception — Recent Events",
    description:
      "Devuelve los últimos N eventos del bus de percepción (ring buffer in-memory). Tipos: " +
      "start | frame | foreground | heartbeat | error | shutdown. Util para responder 'qué ha cambiado " +
      "en pantalla últimamente' sin necesitar suscripción push.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 30 })),
      kind: Type.Optional(
        Type.Union(
          [
            Type.Literal("start"),
            Type.Literal("frame"),
            Type.Literal("foreground"),
            Type.Literal("heartbeat"),
            Type.Literal("error"),
            Type.Literal("shutdown"),
          ],
          { description: "Filter to one event kind." },
        ),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { limit?: number; kind?: string };
      let events = deps.bus.recent(params.limit ?? 30);
      if (params.kind) events = events.filter((e) => e.kind === params.kind);
      return jsonResult({ ok: true, count: events.length, events });
    },
  };
}

export function createPerceptionHealthTool(): AnyAgentTool {
  return {
    name: "lumina_perception_health",
    label: "Lumina Perception — Health",
    description:
      "Verifica que las dependencias del sidecar (mss + Pillow) estén instaladas. Si devuelve " +
      "ready=false, sugerir a Dal `python -m pip install mss pillow` antes de start.",
    parameters: Type.Object({}),
    async execute() {
      const r = await runPythonSidecarJson<{ ok: boolean; ready: boolean; error?: string }>(
        "perception",
        ["--health"],
        { timeoutMs: 8_000 },
      );
      if (!r.ok) return jsonResult({ ok: false, ready: false, error: r.error });
      return jsonResult({ ok: true, ...r.data });
    },
  };
}
