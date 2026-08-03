/**
 * Lumina Presence — Phase 1 (Cognitive Presence Foundations)
 * ════════════════════════════════════════════════════════════════
 * Passive observer of the OpenClaw runtime. Tracks Lumina's presence
 * state through an event-driven FSM. Exposes a read-only status tool
 * (`lumina_presence_status`) for the agent and for debugging.
 *
 * What this extension does in Phase 1:
 *   - Maintains the 8 presence states (idle / listening / thinking /
 *     working / investigating / learning / waiting / completed).
 *   - Subscribes to an internal event bus for state transitions.
 *   - Provides a `report` API on the heartbeat hook for the lumina-pc
 *     service to feed CPU/RAM data into.
 *   - Exposes the current state via a tool.
 *
 * What this extension does NOT do in Phase 1:
 *   - It does not narrate (Phase 3).
 *   - It does not initiate conversation (Phase 4).
 *   - It does not auto-wire to the existing heartbeat — the runtime owner
 *     calls `getHeartbeatHook()` and feeds it ticks (kept explicit so
 *     cross-plugin coupling is visible).
 *   - It does not persist transitions to disk yet.
 *
 * Design rules upheld here:
 *   - Strict TypeScript across the extension; no `any`.
 *   - Idle == 0% CPU. The only background work is an unref'd setTimeout.
 *   - Disabled-by-default in the manifest (`enabledByDefault: false`).
 *     The user opts in explicitly per Phase 1's stability bias.
 *   - Fail-open: if the engine throws, the runtime keeps running. We never
 *     let presence errors degrade core OpenClaw operation.
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  mapObservationAgentEvent,
  mapRuntimeAgentEvent,
  OBSERVATION_PRESENCE_STREAM,
} from "./src/bridge/agent-events.js";
import { createPresenceEventBus } from "./src/event-bus.js";
import {
  InitiativeDaemon,
  type InitiativeDaemonConfig,
} from "./src/initiative/initiative-daemon.js";
import { PersonalityLayer } from "./src/personality/personality-layer.js";
import { HeartbeatHook } from "./src/services/heartbeat-hook.js";
import { PresenceEngine, type PresenceEngineConfig, type PresenceLogger } from "./src/services/presence-engine.js";
import { createPresenceStatusTool } from "./src/tools/presence-status.js";

// ── Config shape (mirrors openclaw.plugin.json -> configSchema) ──
type LuminaPresenceConfig = {
  enabled?: boolean;
  stateTransitionLogLevel?: "off" | "summary" | "verbose";
  idleTimeoutMs?: number;
  initiative?: Partial<InitiativeDaemonConfig>;
};

/**
 * Singleton accessor — the extension is loaded once per gateway boot, so
 * we keep a module-scoped reference for tools registered later to grab.
 * Future phases (narrator, initiative) will register additional consumers
 * that need the same bus + engine.
 */
let presenceEngineSingleton: PresenceEngine | null = null;
let heartbeatHookSingleton: HeartbeatHook | null = null;

export function getPresenceEngine(): PresenceEngine | null {
  return presenceEngineSingleton;
}

export function getHeartbeatHook(): HeartbeatHook | null {
  return heartbeatHookSingleton;
}

export default definePluginEntry({
  id: "lumina-presence",
  name: "Lumina Presence",
  description:
    "Lumina cognitive presence layer. Tracks runtime and observation events, projects personality state, and supports controlled proactive updates.",

  register(api) {
    // Read plugin config, defaulting safely.
    const raw = (api.pluginConfig ?? {}) as LuminaPresenceConfig;
    const cfg: PresenceEngineConfig = {
      enabled: raw.enabled ?? true,
      stateTransitionLogLevel: raw.stateTransitionLogLevel ?? "summary",
      idleTimeoutMs: raw.idleTimeoutMs ?? 60_000,
    };

    if (!cfg.enabled) {
      return;
    }

    // Logger: prefer the runtime-provided logger if the plugin SDK exposes
    // one, fall back to console. We coerce its shape to PresenceLogger.
    const logger: PresenceLogger = api.logger;

    const bus = createPresenceEventBus();
    const engine = new PresenceEngine(bus, cfg, logger);

    try {
      engine.start();
    } catch (err) {
      // Fail-open: never let the presence layer crash the runtime.
      logger.warn("[lumina-presence] failed to start engine", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const heartbeat = new HeartbeatHook(bus);
    const personality = new PersonalityLayer(engine);
    personality.start();
    const initiativeConfig = raw.initiative ?? {};
    const initiative = new InitiativeDaemon(
      {
        enabled: initiativeConfig.enabled ?? false,
        defaultSessionKey: initiativeConfig.defaultSessionKey ?? "agent:main:main",
        cooldownMs: initiativeConfig.cooldownMs ?? 300_000,
        dedupeWindowMs: initiativeConfig.dedupeWindowMs ?? 1_800_000,
        maxInitiativesPerHour: initiativeConfig.maxInitiativesPerHour ?? 3,
        quietHoursStart: initiativeConfig.quietHoursStart ?? 23,
        quietHoursEnd: initiativeConfig.quietHoursEnd ?? 8,
      },
      (params) => api.session.workflow.scheduleSessionTurn(params),
      logger,
    );
    presenceEngineSingleton = engine;
    heartbeatHookSingleton = heartbeat;

    // Tool registration — wraps the engine in a read-only status tool.
    api.agent.events.registerAgentEventSubscription({
      id: "lumina-presence-events",
      description:
        "Bridge sanitized OpenClaw and Lumina Observation events into the private presence bus.",
      streams: ["lifecycle", "tool", OBSERVATION_PRESENCE_STREAM],
      async handle(event) {
        initiative.rememberSession(event.sessionKey);
        const observationEvents = mapObservationAgentEvent(event);
        for (const presenceEvent of [...mapRuntimeAgentEvent(event), ...observationEvents]) {
          bus.emit(presenceEvent);
        }

        const data =
          event.data && typeof event.data === "object" && !Array.isArray(event.data)
            ? (event.data as Record<string, unknown>)
            : null;
        if (event.stream === "lifecycle" && data?.phase === "error") {
          await initiative.consider({
            kind: "error.important",
            priority: "critical",
            dedupeKey: `agent-error:${event.sessionKey ?? event.runId}`,
            summary: "Detecté un error importante en una tarea.",
            detail: typeof data.error === "string" ? data.error : undefined,
            sessionKey: event.sessionKey,
          });
        }
        if (event.stream === "tool" && data?.phase === "result" && data.isError === true) {
          const toolName = typeof data.name === "string" ? data.name : "herramienta";
          await initiative.consider({
            kind: "task.blocked",
            priority: "high",
            dedupeKey: `tool-error:${toolName}:${event.sessionKey ?? event.runId}`,
            summary: `Una herramienta necesaria quedó bloqueada: ${toolName}.`,
            sessionKey: event.sessionKey,
          });
        }
        for (const presenceEvent of observationEvents) {
          if (
            presenceEvent.kind === "observation.process.spiked" &&
            presenceEvent.workingSetMB >= 4_096 &&
            presenceEvent.workingSetMB - presenceEvent.previousMB >= 1_024
          ) {
            await initiative.consider({
              kind: "risk.detected",
              priority: "high",
              dedupeKey: `process-spike:${presenceEvent.processName}`,
              summary: "Detecté un aumento inusual de memoria en una aplicación.",
              detail: `${presenceEvent.processName}: ${Math.round(presenceEvent.workingSetMB)} MB`,
              sessionKey: event.sessionKey,
            });
          }
        }
      },
    });

    api.on("agent_end", async (event, ctx) => {
      initiative.rememberSession(ctx.sessionKey);
      if (event.success && isBackgroundTrigger(ctx.trigger)) {
        await initiative.consider({
          kind: "task.completed",
          priority: "normal",
          dedupeKey: `background-completed:${ctx.sessionKey ?? event.runId ?? "main"}`,
          summary: "Terminó una tarea en segundo plano.",
          sessionKey: ctx.sessionKey,
        });
      }
    });

    api.on("agent_turn_prepare", (_event, ctx) => {
      initiative.rememberSession(ctx.sessionKey);
      const current = personality.snapshot();
      return {
        appendContext:
          `[Lumina Presence] Estado actual: ${current.state}. ` +
          "Mantén una voz humana y breve. Herramientas cognitivas disponibles: " +
          "lumina_presence_status, lumina_observation_snapshot, lumina_narration_recent, " +
          "lumina_memory_recall, lumina_memory_remember, lumina_memory_profile_read y " +
          "lumina_memory_profile_update.",
      };
    });

    api.registerTool(createPresenceStatusTool(engine, personality, initiative));
    api.lifecycle.registerRuntimeLifecycle({
      id: "lumina-presence-cleanup",
      description: "Stop presence timers and subscriptions during plugin lifecycle cleanup.",
      cleanup: () => {
        personality.stop();
        engine.stop();
        presenceEngineSingleton = null;
        heartbeatHookSingleton = null;
      },
    });

    // NOTE: no background services registered yet. The heartbeat HOOK exists
    // but is fed externally; Phase 2/3 will wire it to the lumina-pc service
    // through a tiny shared module rather than reaching across plugin
    // boundaries here.
  },
});

function isBackgroundTrigger(trigger: string | undefined): boolean {
  const value = trigger?.toLowerCase() ?? "";
  return (
    value.includes("cron") ||
    value.includes("heartbeat") ||
    value.includes("scheduled") ||
    value.includes("subagent")
  );
}
