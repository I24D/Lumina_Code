/**
 * Lumina Observation — Phase 3 (Observation + Narration)
 * ════════════════════════════════════════════════════════════════
 * Polls the desktop every `pollIntervalMs` ms (30 s default) and emits
 * narrations for SIGNIFICANT changes only. The narrator is off by
 * default — turn it on once you've validated the filter is producing
 * useful signals from your typical workflow.
 *
 * What this extension does in Phase 3:
 *   - Foreground window observer (Win32 GetForegroundWindow via PS)
 *   - Top-process-by-RAM observer (Get-Process)
 *   - User idle observer (GetLastInputInfo)
 *   - Anti-spam change filter
 *   - Optional LLM narrator (one-shot, ≤ 80 chars, Spanish)
 *   - Two tools: lumina_observation_snapshot, lumina_narration_recent
 *
 * What this extension does NOT do:
 *   - It does not speak. Phase 4 wires narrations into Talk.
 *   - It does not control inputs. Phase 6 owns that surface.
 *   - It does not look at screen pixels or window contents — only titles.
 *
 * Fail-open: any observer that throws is treated as null for that tick.
 * Disabled by default; opt-in via plugins.entries.lumina-observation.
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildObservationPresenceEnvelope,
  OBSERVATION_PRESENCE_RUN_ID,
  OBSERVATION_PRESENCE_STREAM,
} from "./src/bridge/presence-events.js";
import { LlmClient } from "./src/narrator/llm-client.js";
import { NarratorEngine } from "./src/narrator/narrator-engine.js";
import { ObservationService } from "./src/services/observation-service.js";
import { createObservationSnapshotTool } from "./src/tools/observation-snapshot.js";
import { createNarrationRecentTool } from "./src/tools/narration-recent.js";

type LuminaObservationConfig = {
  enabled?: boolean;
  pollIntervalMs?: number;
  idleThresholdMs?: number;
  narration?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxNarrationsPerMinute?: number;
  };
};

interface ObservationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export default definePluginEntry({
  id: "lumina-observation",
  name: "Lumina Observation",
  description:
    "Desktop observers (foreground window, top process, user idle) + anti-spam change filter + optional LLM narrator. Phase 3. Read-only; never controls inputs. Two tools: lumina_observation_snapshot, lumina_narration_recent.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as LuminaObservationConfig;
    if (raw.enabled === false) return;

    const logger: ObservationLogger = api.logger;

    const narrationCfg = raw.narration ?? {};
    const llm = new LlmClient({
      baseUrl: narrationCfg.baseUrl ?? "http://127.0.0.1:4321/v1/chat/completions",
      model: narrationCfg.model ?? "gemini-2.5-flash",
      apiKey: narrationCfg.apiKey,
    });
    const narrator = new NarratorEngine(llm, {
      maxNarrationsPerMinute: narrationCfg.maxNarrationsPerMinute ?? 4,
    });

    const service = new ObservationService(
      {
        pollIntervalMs: raw.pollIntervalMs ?? 30_000,
        idleThresholdMs: raw.idleThresholdMs ?? 120_000,
        narrationEnabled: narrationCfg.enabled === true,
        onChanges(changes, snapshot) {
          const emitted = api.agent.events.emitAgentEvent({
            runId: OBSERVATION_PRESENCE_RUN_ID,
            stream: OBSERVATION_PRESENCE_STREAM,
            data: buildObservationPresenceEnvelope(snapshot, changes),
          });
          if (!emitted.emitted) {
            logger.warn("[lumina-observation] presence event not emitted", {
              reason: emitted.reason,
            });
          }
        },
      },
      narrator,
      logger,
    );

    try {
      service.start();
    } catch (err) {
      logger.warn("[lumina-observation] failed to start", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    api.registerTool(createObservationSnapshotTool(service));
    api.registerTool(createNarrationRecentTool(service));
    api.lifecycle.registerRuntimeLifecycle({
      id: "lumina-observation-cleanup",
      description: "Stop the desktop observation loop when the plugin is reloaded or disabled.",
      cleanup: () => service.stop(),
    });
  },
});
