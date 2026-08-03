/**
 * Lumina Cognitive OS — Niveles 1-12 (Codex roadmap)
 * ════════════════════════════════════════════════════════════════
 * Single extension that ties together every capability required to turn
 * Lumina from "chatbot" into "Cognitive Operating System". All tools are
 * registered with OpenClaw's tool registry so the user can invoke them
 * by voice via Start Talk.
 *
 *   Nivel 1  Environment Awareness        → lumina_awareness_snapshot/_subscribe
 *   Nivel 2  Working + Episodic memory    → lumina_working_memory_*, _episodic_*
 *   Nivel 3  Vision (UI Tree + multimon)  → lumina_vision_ui_tree, _multimonitor
 *   Nivel 4  Browser driver + planner     → lumina_browser_drive, _action_plan
 *   Nivel 5  Director (12 specialists)    → lumina_director_route
 *   Nivel 8  Transparency log             → lumina_transparency_publish/_recent
 *   Nivel 9  Intent router + templates    → lumina_intent_run
 *   Nivel 10 Risk evaluation 4-tier       → lumina_risk_evaluate / _recent
 *   Nivel 11 MCP Gmail/Calendar/Drive     → lumina_gmail, _calendar, _drive
 *   Nivel 12 Boot greeting + wake-word    → lumina_boot_greeting, _wake_word
 *
 * Niveles 6 (Start Talk states) and 7 (avatar expressions) are UI-only
 * and live in the `ui/src/ui/chat` folder.
 * ════════════════════════════════════════════════════════════════
 */
import path from "node:path";
import os from "node:os";

// Global error handlers — catch unhandled rejections and uncaught exceptions
// to prevent silent failures in long-running gateway sessions.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[lumina-cognitive-os] Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err, origin) => {
  console.error("[lumina-cognitive-os] Uncaught Exception:", err, "origin:", origin);
});
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { loadLuminaEnv } from "./src/env.js";

// Risk
import { RiskEngine } from "./src/risk/risk-engine.js";
import { createRiskEvaluateTool, createRiskRecentTool } from "./src/risk/risk-tool.js";

// Awareness
import { AwarenessEventBus } from "./src/awareness/event-bus.js";
import { AwarenessPoller } from "./src/awareness/snapshot.js";
import {
  createAwarenessSnapshotTool,
  createAwarenessSubscribeTool,
} from "./src/awareness/awareness-tool.js";
import { createWindowsContextTool } from "./src/awareness/windows-context-tool.js";
import {
  createPhoneLinkReplyTool,
  createPhoneLinkStatusTool,
  createWhatsappRespondTool,
} from "./src/awareness/phone-link-tool.js";

// Memory
import { WorkingMemoryStore } from "./src/memory/working-memory.js";
import { EpisodicMemoryStore } from "./src/memory/episodic-memory.js";
import { ActionLogStore } from "./src/memory/action-log.js";
import {
  createWorkingMemoryGetTool,
  createWorkingMemorySetTool,
  createEpisodicRememberTool,
  createEpisodicRecallTool,
} from "./src/memory/memory-tools.js";
import {
  createWorkingMemoryRecallTool,
  createWorkingMemoryLogTool,
} from "./src/memory/action-log-tool.js";

// Vision
import { createUiTreeTool } from "./src/vision/ui-automation.js";
import { createUiResolveTool } from "./src/vision/ui-resolve.js";
import { createUiInvokeTool } from "./src/vision/ui-invoke.js";
import { createSightTool } from "./src/vision/sight.js";
import { createMultiMonitorTool } from "./src/vision/multi-monitor.js";
import { createWindowClassifyTool } from "./src/vision/window-classify-tool.js";

// Action
import { createPlanStore, createActionPlanTool } from "./src/action/action-tools.js";
import { createBrowserDriverTool } from "./src/action/browser-driver.js";
import { createBrowserScreencastTool } from "./src/action/browser-screencast.js";
import { createBrowserSessionTool } from "./src/action/browser-session.js";
import { createSmartClickTool, createSmartTypeTool } from "./src/action/smart-click.js";
import {
  createPcObserveTool,
  createPcScrollTool,
  createPcDragTool,
} from "./src/action/pc-tools.js";
import {
  createBrowserSmartClickTool,
  createBrowserSmartTypeTool,
  createBrowserDomObserveTool,
  createBrowserDomScreenshotTool,
} from "./src/action/browser-smart-click.js";
import { createBrowserNaturalTool } from "./src/action/browser-natural.js";
import {
  createAppListTool,
  createAppLaunchTool,
  createAppCloseTool,
} from "./src/action/app-tools.js";

// PC Operator Loop (Camino A — autonomous observe→think→act→verify)
import { createBridgeClient } from "./src/shared/bridge-client.js";
import { createMultiProviderBrain } from "./src/operator/brain-multi.js";
import type { BrainProviderName } from "./src/operator/brain-gemini.js";
import { PcOperatorEngine } from "./src/operator/loop-engine.js";
// Harness wire-up (live behind a try/catch in register() so cognitive-os
// boot survives if the Harness package isn't on the classpath in some envs).
import { getLuminaHarnessRuntime, createPcOperatorHarnessTool } from "../../src/harness/index.js";
import {
  createLuminaHarnessHealthTool,
  createLuminaHarnessTaskTool,
} from "./src/harness/harness-task-tool.js";
import {
  createPcDoTool,
  createPcDoStatusTool,
  createPcDoListTool,
  createPcDoAbortTool,
  createPcDoCostSummaryTool,
  createPcDoSkillHealthTool,
  createPcDoSkillResetTool,
} from "./src/operator/loop-tools.js";
import { CostMeter } from "./src/operator/cost-meter.js";
import { SkillHealthTracker } from "./src/operator/skill-health-tracker.js";

// Continuous Perception (sidecar Python que vigila la pantalla en bucle)
import {
  PerceptionProcess,
  createPerceptionBus,
} from "./src/perception/perception-process.js";
import {
  createPerceptionStartTool,
  createPerceptionStopTool,
  createPerceptionPauseTool,
  createPerceptionResumeTool,
  createPerceptionTuneTool,
  createPerceptionStatusTool,
  createPerceptionRecentTool,
  createPerceptionHealthTool,
} from "./src/perception/perception-tools.js";

// Global emergency stop (§9): panic hotkey sidecar + software twin tool.
import { KillSwitchProcess } from "./src/operator/kill-switch-process.js";
import { createKillSwitchTool } from "./src/operator/kill-switch-tool.js";

// App Adapter Registry (§5): specialized structural adapters before generic UIA.
import { createOfficeTool } from "./src/adapters/office-tool.js";
import { createRegistryTool } from "./src/adapters/registry-tool.js";
import { createAudioTool } from "./src/adapters/audio-tool.js";
import { createAdapterResolveTool } from "./src/adapters/adapter-resolve-tool.js";

// Agents
import { createDirectorRouteTool } from "./src/agents/director-tool.js";

// Automation
import { createIntentRunTool } from "./src/automation/intent-tool.js";
import { WorkflowEngine, type WorkflowEnvironment } from "./src/automation/workflow-engine.js";
import {
  createWorkflowListTool,
  createWorkflowRunTool,
} from "./src/automation/workflow-tool.js";

// Skills (agentskills.io standard)
import { SkillLoader } from "./src/skills/skill-loader.js";
import {
  createSkillListTool,
  createSkillDescribeTool,
  createSkillReadAssetTool,
  createSkillRunTool,
} from "./src/skills/skill-tools.js";
import { createSkillFromRecordingTool } from "./src/skills/skill-from-recording-tool.js";

// Governance
import { GovernanceEngine, createGovernanceEvaluateTool, createGovernancePolicyTool } from "./src/governance/governance-policy.js";
import { SkillEvalStore } from "./src/skills/skill-eval.js";
import { createSkillEvalTool, createSkillEvalRecordTool } from "./src/skills/skill-eval-tool.js";

// Vision (OmniParser opt-in)
import { createOmniParserTool, createOmniParserHealthTool } from "./src/vision/omniparser-tool.js";

// Recorder (LfD Fase B)
import { RecorderProcess } from "./src/recorder/recorder-process.js";
import { RecorderStore } from "./src/recorder/recorder-store.js";
import {
  createRecorderStartTool,
  createRecorderStopTool,
  createRecorderPauseTool,
  createRecorderResumeTool,
  createRecorderStatusTool,
  createRecorderListTool,
  createRecorderGetTool,
  createRecorderDeleteTool,
} from "./src/recorder/recorder-tool.js";

// Replay (LfD Fase C)
import {
  ReplayEngine,
  defaultLiveContextProvider,
  defaultActionDispatcher,
} from "./src/replay/replay-engine.js";
import {
  createReplayRunTool,
  createReplayStatusTool,
  createReplayListTool,
  createReplayAbortTool,
  createReplayStrategiesTool,
} from "./src/replay/replay-tool.js";
import { configureOmniParserClient } from "./src/replay/strategies/vision-grounded.js";
import { runPythonSidecarJson } from "./src/shared/python.js";
import type { DetectedElement } from "./src/vision/set-of-marks.js";

// Code execute (Fase 2)
import { createCodeExecuteTool } from "./src/code/code-execute-tool.js";

// Operative daemon (Fase 3 — proactive Lumina)
import { OperativeDaemon } from "./src/operative/operative-daemon.js";
import {
  createOperativeStatusTool,
  createOperativeEnableTool,
  createOperativeDisableTool,
  createOperativeReloadTool,
  createOperativeRecentTool,
} from "./src/operative/operative-tool.js";

// CodeAct loop (Fase 6 — LLM-writes-Python pattern)
import { CodeActEngine } from "./src/codeact/codeact-loop.js";
import {
  createCodeActStartTool,
  createCodeActStepTool,
  createCodeActStatusTool,
  createCodeActEndTool,
} from "./src/codeact/codeact-tool.js";

// MCP
import { createGmailTool } from "./src/mcp/gmail-tool.js";
import { createCalendarTool } from "./src/mcp/calendar-tool.js";
import { createDriveTool } from "./src/mcp/drive-tool.js";

// Supabase
import {
  createSupabaseStatusTool,
  createSupabaseSchemaTool,
  createSupabaseQueryTool,
  createSupabaseMutateTool,
} from "./src/supabase/supabase-tools.js";
import {
  createLuminaMemoryStatusTool,
  createLuminaMemorySearchTool,
  createLuminaMemoryRememberTool,
  createLuminaWarehouseCatalogTool,
} from "./src/supabase/lumina-memory-tools.js";

// Presence
import { createBootGreetingTool } from "./src/presence/boot-greeting.js";
import { WakeWordDaemon, createWakeWordTool } from "./src/presence/wake-word.js";

// Transparency
import { ActivityLog } from "./src/transparency/activity-log.js";
import { setActiveActivityLog } from "./src/transparency/singleton.js";
import {
  createTransparencyPublishTool,
  createTransparencyRecentTool,
} from "./src/transparency/transparency-tool.js";

type CognitiveConfig = {
  enabled?: boolean;
  envPath?: string;
  memoryDir?: string;
  awarenessIntervalMs?: number;
  wakeWordEnabled?: boolean;
  wakeWordModel?: string;
  bootGreetingEnabled?: boolean;
  browserDriverEnabled?: boolean;
  perceptionAutoStart?: boolean;
  perceptionFps?: number;
  recipesDir?: string;
  bridgeUrl?: string;
  skillsDir?: string;
  operativeEnabled?: boolean;
  operativeRulesPath?: string;
  codeActWorkspaceRoot?: string;
  recordingsDir?: string;
  replayAllowedApps?: string[];
  pcOperatorProvider?: BrainProviderName;
  pcOperatorModel?: string;
  supabaseSchema?: string;
  supabaseMaxRows?: number;
  supabaseAllowWrites?: boolean;
  warehousesPath?: string;
  governancePolicyPath?: string;
};

function parseAllowedApps(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function readNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultMemoryDir(): string {
  const base =
    process.env.APPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".lumina-cognitive-os");
  return path.join(base, "lumina-cognitive-os", "memory");
}

/**
 * Builds a WorkflowEnvironment from the lumina-windows-bridge so the
 * workflow engine can evaluate `process_running` / `window_title_contains`
 * preconditions. Always returns SOMETHING — if the bridge is unreachable
 * (offline, WSL-only run), the engine simply won't skip any step.
 */
async function fetchWorkflowEnvironment(bridgeUrl: string): Promise<WorkflowEnvironment> {
  const empty: WorkflowEnvironment = {
    runningProcessNames: new Set<string>(),
    visibleWindowTitles: [],
  };
  if (!bridgeUrl || typeof fetch !== "function") return empty;
  const base = bridgeUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const [procsRes, winRes] = await Promise.all([
      fetch(`${base}/processes`, { signal: controller.signal }).catch(() => null),
      fetch(`${base}/window_control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: controller.signal,
      }).catch(() => null),
    ]);
    const runningProcessNames = new Set<string>();
    if (procsRes && procsRes.ok) {
      try {
        const body = (await procsRes.json()) as { processes?: Array<{ ProcessName?: string }> };
        for (const p of body.processes ?? []) {
          if (typeof p.ProcessName === "string" && p.ProcessName.trim()) {
            runningProcessNames.add(p.ProcessName.trim());
          }
        }
      } catch { /* ignore */ }
    }
    const visibleWindowTitles: string[] = [];
    if (winRes && winRes.ok) {
      try {
        const body = (await winRes.json()) as { windows?: Array<{ title?: string }> };
        for (const w of body.windows ?? []) {
          if (typeof w.title === "string" && w.title.trim()) {
            visibleWindowTitles.push(w.title.trim());
          }
        }
      } catch { /* ignore */ }
    }
    return { runningProcessNames, visibleWindowTitles };
  } finally {
    clearTimeout(timer);
  }
}

export default definePluginEntry({
  id: "lumina-cognitive-os",
  name: "Lumina Cognitive OS",
  description:
    "Niveles 1-12 of the Lumina Cognitive Operating System: awareness, memory, vision, action, multi-agent, " +
    "intent router, MCP Gmail/Calendar/Drive, boot greeting, wake-word. Every capability is exposed as an " +
    "agent tool so the user can invoke it by voice via Start Talk.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as CognitiveConfig;
    const envPath = raw.envPath ?? "c:/I24D_WhatsApp/.env";
    const luminaEnv = loadLuminaEnv({ envPath });
    const cfg: Required<CognitiveConfig> = {
      enabled: raw.enabled ?? true,
      envPath,
      memoryDir: raw.memoryDir ?? defaultMemoryDir(),
      awarenessIntervalMs: raw.awarenessIntervalMs ?? 15_000,
      wakeWordEnabled: raw.wakeWordEnabled ?? false,
      wakeWordModel: raw.wakeWordModel ?? "hey_jarvis_v0.1",
      bootGreetingEnabled: raw.bootGreetingEnabled ?? true,
      browserDriverEnabled: raw.browserDriverEnabled ?? false,
      perceptionAutoStart: raw.perceptionAutoStart ?? false,
      perceptionFps: raw.perceptionFps ?? 3,
      recipesDir: raw.recipesDir ?? "",
      bridgeUrl: raw.bridgeUrl ?? process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765",
      skillsDir: raw.skillsDir ?? process.env.LUMINA_SKILLS_DIR ?? "c:/I24D_WhatsApp/skills",
      operativeEnabled: raw.operativeEnabled ?? true,
      operativeRulesPath: raw.operativeRulesPath ?? process.env.LUMINA_OPERATIVE_RULES ?? "",
      codeActWorkspaceRoot:
        raw.codeActWorkspaceRoot ?? process.env.LUMINA_CODEACT_WORKSPACE ?? "c:/I24D_WhatsApp/codeact-workspace",
      recordingsDir:
        raw.recordingsDir ?? process.env.LUMINA_RECORDINGS_DIR ?? "c:/I24D_WhatsApp/recordings",
      replayAllowedApps: raw.replayAllowedApps ?? parseAllowedApps(process.env.LUMINA_REPLAY_ALLOWED_APPS),
      pcOperatorProvider:
        raw.pcOperatorProvider ?? (process.env.LUMINA_PC_OPERATOR_PROVIDER as BrainProviderName | undefined) ?? "auto",
      pcOperatorModel: raw.pcOperatorModel ?? process.env.LUMINA_PC_OPERATOR_MODEL ?? "",
      supabaseSchema:
        raw.supabaseSchema ??
        process.env.LUMINA_SUPABASE_SCHEMA ??
        luminaEnv.LUMINA_SUPABASE_SCHEMA ??
        "public",
      supabaseMaxRows:
        raw.supabaseMaxRows ??
        readNumberEnv(process.env.LUMINA_SUPABASE_MAX_ROWS) ??
        readNumberEnv(luminaEnv.LUMINA_SUPABASE_MAX_ROWS) ??
        100,
      supabaseAllowWrites:
        readBooleanEnv(process.env.LUMINA_SUPABASE_ALLOW_WRITES) ??
        readBooleanEnv(luminaEnv.LUMINA_SUPABASE_ALLOW_WRITES) ??
        raw.supabaseAllowWrites ??
        false,
      warehousesPath:
        raw.warehousesPath ??
        process.env.LUMINA_WAREHOUSES_PATH ??
        luminaEnv.LUMINA_WAREHOUSES_PATH ??
        "c:/I24D_WhatsApp/src/cuerpo/warehouses",
      governancePolicyPath:
        raw.governancePolicyPath ?? process.env.LUMINA_GOVERNANCE_POLICY_PATH ?? "",
    };

    if (!cfg.enabled) {
      api.logger.info("[lumina-cognitive-os] disabled by config");
      return;
    }

    // Env cache is warmed above so tool calls don't pay the read cost.

    // ── N10 Risk Engine ──────────────────────────────────────────
    const risk = new RiskEngine();
    api.registerTool(createRiskEvaluateTool(risk));
    api.registerTool(createRiskRecentTool(risk));

    // ── N1 Environment Awareness ─────────────────────────────────
    const awarenessBus = new AwarenessEventBus();
    const poller = new AwarenessPoller(cfg.awarenessIntervalMs, awarenessBus);
    const systemBridgeClient = createBridgeClient({ bridgeUrl: cfg.bridgeUrl });
    poller.start();
    api.registerTool(createAwarenessSnapshotTool(poller));
    api.registerTool(createAwarenessSubscribeTool(awarenessBus));
    api.registerTool(createWindowsContextTool(systemBridgeClient));
    // WhatsApp respond first: it is the fast one-call path (contact + message)
    // and the preferred tool for answering a notification quickly. The exact
    // metadata reply and status checks follow.
    api.registerTool(createWhatsappRespondTool(systemBridgeClient));
    api.registerTool(createPhoneLinkStatusTool(systemBridgeClient));
    api.registerTool(createPhoneLinkReplyTool(systemBridgeClient));

    // ── N2 Memory ────────────────────────────────────────────────
    const working = new WorkingMemoryStore(cfg.memoryDir);
    const episodic = new EpisodicMemoryStore(cfg.memoryDir);
    const actionLog = new ActionLogStore(cfg.memoryDir);
    api.registerTool(createWorkingMemoryGetTool(working));
    api.registerTool(createWorkingMemorySetTool(working));
    api.registerTool(createEpisodicRememberTool(episodic));
    api.registerTool(createEpisodicRecallTool(episodic));
    // Spec 3 — semantic action log (auto-fed by workflow engine)
    api.registerTool(createWorkingMemoryRecallTool(actionLog));
    api.registerTool(createWorkingMemoryLogTool(actionLog));

    // ── N3 Vision ────────────────────────────────────────────────
    api.registerTool(createUiTreeTool());
    // Spec 2 — natural-language → automationId/bbox resolver
    api.registerTool(createUiResolveTool());
    // Native UIA pattern action (Invoke/SetValue/Toggle) by identity — more
    // reliable than coordinate clicks for off-screen / non-foreground elements.
    api.registerTool(createUiInvokeTool());
    // Live sight: current foreground + actionable elements from continuous
    // perception (served by the windows-bridge). Act-on-current-state in one step.
    api.registerTool(createSightTool(cfg.bridgeUrl));
    api.registerTool(createMultiMonitorTool());
    // §3 router: classify the foreground window → recommended engine order.
    api.registerTool(createWindowClassifyTool(cfg.bridgeUrl));

    // ── N4 Action ────────────────────────────────────────────────
    const planStore = createPlanStore();
    api.registerTool(createActionPlanTool(planStore));
    api.registerTool(createBrowserDriverTool({ enabled: cfg.browserDriverEnabled }));
    api.registerTool(createBrowserScreencastTool());
    api.registerTool(createBrowserSessionTool());
    // Smart Click / Type — closed-loop UIA-resolve → dispatch → verify.
    // Reuses Bridge + replayAllowedApps so the same per-process guard applies.
    const smartClickDeps = { bridgeUrl: cfg.bridgeUrl, allowedApps: cfg.replayAllowedApps };
    const smartClickTool = createSmartClickTool(smartClickDeps);
    const smartTypeTool = createSmartTypeTool(smartClickDeps);
    api.registerTool(smartClickTool);
    api.registerTool(smartTypeTool);
    // PC Operator suite: unified observe + scroll + drag.
    const pcObserveTool = createPcObserveTool(smartClickDeps);
    const pcScrollTool = createPcScrollTool(smartClickDeps);
    const pcDragTool = createPcDragTool(smartClickDeps);
    api.registerTool(pcObserveTool);
    api.registerTool(pcScrollTool);
    api.registerTool(pcDragTool);
    // Browser DOM-aware smart tools (reuse browserDriverEnabled flag).
    const browserSmartClickTool = createBrowserSmartClickTool({ enabled: cfg.browserDriverEnabled });
    const browserSmartTypeTool = createBrowserSmartTypeTool({ enabled: cfg.browserDriverEnabled });
    const browserDomObserveTool = createBrowserDomObserveTool({ enabled: cfg.browserDriverEnabled });
    const browserDomScreenshotTool = createBrowserDomScreenshotTool({ enabled: cfg.browserDriverEnabled });
    const browserNaturalTool = createBrowserNaturalTool({ enabled: cfg.browserDriverEnabled });
    api.registerTool(browserSmartClickTool);
    api.registerTool(browserSmartTypeTool);
    api.registerTool(browserDomObserveTool);
    api.registerTool(browserDomScreenshotTool);
    api.registerTool(browserNaturalTool);

    // App launcher/closer/discovery — Get-StartApps fuzzy fallback + close (WM_CLOSE).
    const appDeps = { bridgeUrl: cfg.bridgeUrl };
    api.registerTool(createAppListTool(appDeps));
    api.registerTool(createAppLaunchTool(appDeps));
    api.registerTool(createAppCloseTool(appDeps));

    // App Adapter Registry (§5): structural adapters preferred before generic
    // UIA — Office COM, Registry, Audio + a resolver that says which to use.
    api.registerTool(createAdapterResolveTool());
    api.registerTool(createOfficeTool());
    api.registerTool(createRegistryTool());
    api.registerTool(createAudioTool());

    // ── Camino A: PC Operator Loop (autonomous observe→think→act→verify) ─
    const pcOperatorCostMeter = new CostMeter({ log: actionLog });
    const pcOperatorBridgeClient = systemBridgeClient;
    const pcOperatorSkillHealth = new SkillHealthTracker({
      log: actionLog,
      notifyToast: (msg) => {
        // Best-effort Bridge toast so Dal actually sees the self-healing warning.
        pcOperatorBridgeClient
          .post("/notify_toast", { title: "Lumina — Skill Health", message: msg }, 3_000)
          .catch(() => undefined);
      },
    });
    const pcOperatorEngine = new PcOperatorEngine({
      brain: createMultiProviderBrain({
        envPath: cfg.envPath,
        defaultProvider: cfg.pcOperatorProvider,
        defaultModel: cfg.pcOperatorModel || undefined,
      }),
      tools: {
        smart_click: smartClickTool,
        smart_type: smartTypeTool,
        pc_scroll: pcScrollTool,
        pc_drag: pcDragTool,
        pc_observe: pcObserveTool,
        browser_smart_click: browserSmartClickTool,
        browser_smart_type: browserSmartTypeTool,
        browser_dom_observe: browserDomObserveTool,
        browser_dom_screenshot: browserDomScreenshotTool,
      },
      bridge: pcOperatorBridgeClient,
      allowedApps: cfg.replayAllowedApps,
      log: actionLog,
      costMeter: pcOperatorCostMeter,
      onLearnedSkillResult: (result) => pcOperatorSkillHealth.record(result),
    });
    api.registerTool(createPcDoTool(pcOperatorEngine));
    api.registerTool(createPcDoStatusTool(pcOperatorEngine));
    api.registerTool(createPcDoListTool(pcOperatorEngine));
    api.registerTool(createPcDoAbortTool(pcOperatorEngine));
    api.registerTool(createPcDoCostSummaryTool(pcOperatorCostMeter));
    api.registerTool(createPcDoSkillHealthTool(pcOperatorSkillHealth));
    api.registerTool(createPcDoSkillResetTool(pcOperatorSkillHealth));
    api.logger.info(
      `[lumina-cognitive-os] PC Operator Loop ready (provider=${cfg.pcOperatorProvider}, model=${cfg.pcOperatorModel || "auto"}). Call lumina_pc_do to start.`,
    );

    // ── Harness wire-up: register pc_operator.run so harness.pc_operator.run works ──
    // The cognitive-os plugin is the only code that knows about PcOperatorEngine
    // concretely, so we wire it up here. The Harness folder itself stays clean.
    try {
      // Lazy import — only when the cognitive-os plugin is loaded does the
      // Harness's pc_operator.run tool become available. Other clients of the
      // gateway still see the tool returning UNAVAILABLE when cognitive-os is
      // disabled, which is the intended behavior.
      const harnessRuntime = getLuminaHarnessRuntime();
      const pcOperatorHarnessDefinition = createPcOperatorHarnessTool({
        runner: async (params) => {
          const run = await pcOperatorEngine.run({
            goal: params.goal,
            mode: params.mode,
            maxIterations: params.maxIterations,
            interStepDelayMs: params.interStepDelayMs,
            preferBrowser: params.preferBrowser,
            brainProvider: params.brainProvider,
            brainModel: params.brainModel,
          });
          return {
            ok: run.status === "done",
            runId: run.id,
            status: run.status,
            goal: run.goal,
            stepCount: run.steps.length,
            finalSummary: run.finalSummary,
            stuckReason: run.stuckReason,
            errorMessage: run.errorMessage,
            steps: run.steps.map((s) => ({
              iteration: s.iteration,
              actionKind: s.action.kind,
              verified: s.dispatch?.verifiedByTool ?? null,
              error: s.dispatch?.errorMessage,
            })),
          };
        },
      });
      harnessRuntime.toolRegistry.upsert(pcOperatorHarnessDefinition);
      api.registerTool(createLuminaHarnessHealthTool(harnessRuntime));
      api.registerTool(createLuminaHarnessTaskTool(harnessRuntime));
      api.logger.info(
        "[lumina-cognitive-os] Harness wire-up complete: health, pc_operator.run and task execution are live.",
      );
    } catch (err) {
      // Never block cognitive-os boot if the Harness import is unavailable.
      api.logger.warn(
        `[lumina-cognitive-os] Could not wire pc_operator.run into Harness: ${(err as Error).message}`,
      );
    }

    // ── Continuous Perception (opt-in via lumina_perception_start) ────
    const perceptionBus = createPerceptionBus(200);
    const perceptionProcess = new PerceptionProcess(perceptionBus, {
      outDir: process.env.LUMINA_PERCEPTION_OUTDIR ?? "",
      fps: cfg.perceptionFps,
    });
    const perceptionDeps = { process: perceptionProcess, bus: perceptionBus };
    api.registerTool(createPerceptionStartTool(perceptionDeps));
    api.registerTool(createPerceptionStopTool(perceptionDeps));
    api.registerTool(createPerceptionPauseTool(perceptionDeps));
    api.registerTool(createPerceptionResumeTool(perceptionDeps));
    api.registerTool(createPerceptionTuneTool(perceptionDeps));
    api.registerTool(createPerceptionStatusTool(perceptionDeps));
    api.registerTool(createPerceptionRecentTool(perceptionDeps));
    api.registerTool(createPerceptionHealthTool());
    // Always-on vision: start the continuous semantic perception loop so Lumina
    // "sees" — foreground app + its actionable UIA elements kept fresh — instead
    // of being blind between on-demand screenshots. Gated by config for privacy.
    if (cfg.perceptionAutoStart) {
      try {
        const started = perceptionProcess.start();
        api.logger.info(
          `[lumina-cognitive-os] perception auto-start: ${started.ok ? `on @ ${cfg.perceptionFps}fps` : `failed: ${started.error}`}`,
        );
      } catch (err) {
        api.logger.warn(`[lumina-cognitive-os] perception auto-start error: ${(err as Error).message}`);
      }
    }
    // (Bridging perception events into the strictly-typed awareness bus
    // would require extending AwarenessEvent + operative rules; skipped for
    // now — events are consumable via lumina_perception_recent.)

    // ── Kill switch (§9): global panic hotkey + software twin ─────────
    // Always-on so Dal can freeze all autonomous PC control instantly (default
    // Ctrl+Alt+K), even mid-action. The switch itself is a pure in-process
    // singleton the loop engine + dispatcher already consult; this just wires
    // the physical hotkey into it.
    const killSwitchProcess = new KillSwitchProcess({
      onEngage: (chord) =>
        api.logger.warn(`[lumina-cognitive-os] KILL SWITCH engaged via ${chord} — operator frozen`),
    });
    api.registerTool(createKillSwitchTool({ process: killSwitchProcess }));
    try {
      const ks = killSwitchProcess.start();
      api.logger.info(
        `[lumina-cognitive-os] kill-switch hotkey: ${ks.ok ? "armed (Ctrl+Alt+K)" : `unavailable: ${ks.error}`}`,
      );
    } catch (err) {
      api.logger.warn(`[lumina-cognitive-os] kill-switch start error: ${(err as Error).message}`);
    }

    // ── N5 Director ──────────────────────────────────────────────
    api.registerTool(createDirectorRouteTool());

    // ── N9 Intent router ─────────────────────────────────────────
    api.registerTool(createIntentRunTool());

    // Spec 1 — Workflow recipes (auto-logged into action log)
    const workflowEngine = new WorkflowEngine({
      recipesDir: cfg.recipesDir || undefined,
      log: actionLog,
    });
    api.registerTool(createWorkflowListTool(workflowEngine));
    api.registerTool(
      createWorkflowRunTool(workflowEngine, () => fetchWorkflowEnvironment(cfg.bridgeUrl)),
    );

    // ── Agent Skills (agentskills.io standard, Fase 1 plan integración) ──
    const skillLoader = new SkillLoader({ skillsDir: cfg.skillsDir });
    api.registerTool(createSkillListTool(skillLoader));
    api.registerTool(createSkillDescribeTool(skillLoader));
    api.registerTool(createSkillReadAssetTool(skillLoader));
    api.registerTool(createSkillRunTool(skillLoader, actionLog));
    const loadedSkills = skillLoader.list().length;
    const loadErrors = skillLoader.errors().length;
    api.logger.info(
      `[lumina-cognitive-os] Agent Skills: ${loadedSkills} loaded, ${loadErrors} errors (dir=${cfg.skillsDir})`,
    );

    // ── Fase 2: Code execute (sandboxed subprocess) ─────────────
    api.registerTool(createCodeExecuteTool({ risk, log: actionLog }));

    // ── Fase 3: Operative daemon (proactive Lumina) ─────────────
    const operative = new OperativeDaemon({
      bus: awarenessBus,
      log: actionLog,
      rulesPath: cfg.operativeRulesPath || undefined,
      autoStart: cfg.operativeEnabled,
    });
    api.registerTool(createOperativeStatusTool(operative));
    api.registerTool(createOperativeEnableTool(operative));
    api.registerTool(createOperativeDisableTool(operative));
    api.registerTool(createOperativeReloadTool(operative));
    api.registerTool(createOperativeRecentTool(operative));

    // ── Fase 6: CodeAct loop (LLM-writes-Python pattern) ─────────
    const codeact = new CodeActEngine({
      risk,
      log: actionLog,
      workspaceRoot: cfg.codeActWorkspaceRoot,
      bridgeUrl: cfg.bridgeUrl,
    });
    api.registerTool(createCodeActStartTool(codeact));
    api.registerTool(createCodeActStepTool(codeact));
    api.registerTool(createCodeActStatusTool(codeact));
    api.registerTool(createCodeActEndTool(codeact));

    // ── LfD Fase A: Visual Engine (OmniParser, opt-in) ───────────
    api.registerTool(createOmniParserTool());
    api.registerTool(createOmniParserHealthTool());
    // Wire the OmniParser sidecar into the vision_grounded replay strategy.
    configureOmniParserClient(async (params) => {
      const args: string[] = ["--image", params.imagePath];
      const r = await runPythonSidecarJson<{ ok: boolean; elements?: DetectedElement[]; error?: string }>(
        "omniparser",
        args,
        { timeoutMs: 90_000 },
      );
      if (!r.ok) return { ok: false, error: r.error };
      const data = r.data ?? { ok: false };
      return { ok: data.ok === true, elements: data.elements, error: data.error };
    });

    // ── LfD Fase B: Recorder ─────────────────────────────────────
    const recorderStore = new RecorderStore(cfg.recordingsDir);
    const recorder = new RecorderProcess(recorderStore);
    api.registerTool(createRecorderStartTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderStopTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderPauseTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderResumeTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderStatusTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderListTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderGetTool({ recorder, log: actionLog }));
    api.registerTool(createRecorderDeleteTool({ recorder, log: actionLog }));

    // ── LfD Fase C: Replay Engine ────────────────────────────────
    const replayEngine = new ReplayEngine({
      store: recorderStore,
      log: actionLog,
      liveContextProvider: defaultLiveContextProvider(cfg.bridgeUrl),
      actionDispatcher: defaultActionDispatcher({
        bridgeUrl: cfg.bridgeUrl,
        allowedApps: cfg.replayAllowedApps,
      }),
    });
    api.registerTool(createReplayRunTool(replayEngine));
    api.registerTool(createReplayStatusTool(replayEngine));
    api.registerTool(createReplayListTool(replayEngine));
    api.registerTool(createReplayAbortTool(replayEngine));
    api.registerTool(createReplayStrategiesTool());

    // ── LfD Fase D: Demo → Skill generator ───────────────────────
    api.registerTool(
      createSkillFromRecordingTool({
        recorderStore,
        skillsDir: cfg.skillsDir,
        log: actionLog,
      }),
    );

    // ── LfD Fase E: Skill eval tracker ───────────────────────────
    const skillEval = new SkillEvalStore(cfg.skillsDir);
    api.registerTool(createSkillEvalTool(skillEval));
    api.registerTool(createSkillEvalRecordTool(skillEval));

    // ── N11 MCP ──────────────────────────────────────────────────
    api.registerTool(createGmailTool());
    api.registerTool(createCalendarTool());
    api.registerTool(createDriveTool());
    const supabaseDeps = {
      envPath: cfg.envPath,
      schema: cfg.supabaseSchema,
      maxRows: cfg.supabaseMaxRows,
      allowWrites: cfg.supabaseAllowWrites,
    };
    api.registerTool(createSupabaseStatusTool(supabaseDeps));
    api.registerTool(createSupabaseSchemaTool(supabaseDeps));
    api.registerTool(createSupabaseQueryTool(supabaseDeps));
    api.registerTool(createSupabaseMutateTool(supabaseDeps));
    const memoryDeps = { ...supabaseDeps, warehousesPath: cfg.warehousesPath };
    api.registerTool(createLuminaMemoryStatusTool(memoryDeps));
    api.registerTool(createLuminaMemorySearchTool(memoryDeps));
    api.registerTool(createLuminaMemoryRememberTool(memoryDeps));
    api.registerTool(createLuminaWarehouseCatalogTool(memoryDeps));
    api.logger.info(
      `[lumina-cognitive-os] Supabase memory tools ready (schema=${cfg.supabaseSchema}, writes=${cfg.supabaseAllowWrites ? "enabled" : "disabled"}).`,
    );

    // ── N12 Presence ─────────────────────────────────────────────
    api.registerTool(createBootGreetingTool());
    const wake = new WakeWordDaemon({
      model: cfg.wakeWordModel,
      threshold: 0.55,
    });
    api.registerTool(createWakeWordTool(wake));
    if (cfg.wakeWordEnabled) {
      const r = wake.start();
      if (!r.ok) {
        api.logger.warn(`[lumina-cognitive-os] wake-word daemon failed to start: ${r.error}`);
      } else {
        api.logger.info("[lumina-cognitive-os] wake-word daemon running");
      }
    }

    // ── N8 Transparency ──────────────────────────────────────────
    const activity = new ActivityLog();
    setActiveActivityLog(activity);
    api.registerTool(createTransparencyPublishTool(activity));
    api.registerTool(createTransparencyRecentTool(activity));

    // ── Governance (Microsoft Agent Governance Toolkit pattern) ──
    const governance = new GovernanceEngine(cfg.governancePolicyPath || "c:/I24D_WhatsApp/governance-policy.json");
    api.registerTool(createGovernanceEvaluateTool(governance));
    api.registerTool(createGovernancePolicyTool(governance));

    // Risk + awareness piped into the transparency log so the UI sees them.
    risk.on((d) => {
      if (d.tier === "SAFE") return; // SAFE → no noise.
      activity.push({
        category: "risk",
        summary: `${d.input.action} → ${d.tier}`,
        detail: d.reason,
        risk: d.tier,
        ref: { input: d.input, ruleId: d.ruleId },
      });
    });
    awarenessBus.on((e) => {
      activity.push({
        category: "intent",
        summary: `Cambio del entorno: ${e.kind}`,
        ref: e,
      });
    });

    // ── Cleanup on plugin teardown ───────────────────────────────
    api.lifecycle.registerRuntimeLifecycle({
      id: "lumina-cognitive-os-cleanup",
      description: "Stop the awareness poller, wake-word daemon, operative daemon, recorder, and perception sidecar.",
      cleanup: () => {
        poller.stop();
        wake.stop();
        operative.stop();
        recorder.shutdown();
        if (perceptionProcess.isRunning()) {
          perceptionProcess.shutdown();
        }
        killSwitchProcess.shutdown();
      },
    });
  },
});
