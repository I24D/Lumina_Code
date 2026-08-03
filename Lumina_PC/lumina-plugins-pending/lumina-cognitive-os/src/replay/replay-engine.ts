/**
 * replay-engine.ts — Orchestrator that walks recorded events, applies a
 * strategy, dispatches each ResolvedAction via the Bridge, verifies
 * post-action, and tracks the run.
 *
 * Architecture:
 *
 *   RecorderStore (Fase B) → events.jsonl
 *           │
 *           ▼
 *   ReplayEngine.run(sessionId, strategy)
 *           │
 *           ▼  for each event:
 *      buildLiveContext()       — screenshot + UIA snapshot + windows list
 *           │
 *           ▼
 *      strategy.resolve(ctx)    — → ResolvedAction
 *           │
 *           ▼
 *      dispatchAction()         — Bridge input_control / wait
 *           │
 *           ▼
 *      verifyPostAction()       — pre/post check per policy
 *           │
 *           ▼  if verify fails → abort
 *      ActionLog append
 *
 * Modes:
 *   - mode='simulate' → dispatchAction is no-op (logs only). Safe to
 *     run anywhere.
 *   - mode='production' → real bridge calls. HIGH_RISK on first step
 *     (caller agent must surface confirmation).
 */
import fs from "node:fs";
import path from "node:path";
import type { RecorderStore, RecordingEvent } from "../recorder/recorder-store.js";
import type { ActionLogStore } from "../memory/action-log.js";
import type {
  LiveContext,
  ReplayStrategy,
  ResolvedAction,
  StrategyContext,
  StrategyId,
  LiveUiaNode,
} from "./strategies/types.js";
import { getStrategy } from "./strategies/registry.js";
import { verifyPostAction, type VerificationResult } from "./verifier.js";

export type ReplayMode = "simulate" | "production";

export type ReplayStepRecord = {
  readonly index: number;
  readonly recordedKind: string;
  readonly resolved: ResolvedAction;
  readonly verification?: VerificationResult;
  readonly dispatched: boolean;
  readonly error?: string;
  readonly atISO: string;
  readonly latencyMs: number;
};

export type ReplayRun = {
  readonly id: string;
  readonly sessionId: string;
  readonly strategyId: StrategyId;
  readonly mode: ReplayMode;
  status: "pending" | "running" | "done" | "aborted" | "error";
  readonly steps: ReplayStepRecord[];
  readonly createdAtISO: string;
  startedAtISO?: string;
  finishedAtISO?: string;
  abortRequested?: boolean;
};

export type LiveContextProvider = () => Promise<LiveContext>;
export type ActionDispatcher = (action: ResolvedAction) => Promise<{ ok: boolean; error?: string }>;

export type ReplayEngineDeps = {
  readonly store: RecorderStore;
  readonly log: ActionLogStore | null;
  readonly liveContextProvider: LiveContextProvider;
  readonly actionDispatcher: ActionDispatcher;
};

let RUN_COUNTER = 0;

export class ReplayEngine {
  private readonly deps: ReplayEngineDeps;
  private runs = new Map<string, ReplayRun>();

  constructor(deps: ReplayEngineDeps) {
    this.deps = deps;
  }

  list(): ReadonlyArray<ReplayRun> {
    return Array.from(this.runs.values()).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO));
  }

  get(id: string): ReplayRun | null {
    return this.runs.get(id) ?? null;
  }

  abort(id: string): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    if (r.status === "done" || r.status === "aborted" || r.status === "error") return false;
    r.abortRequested = true;
    return true;
  }

  async run(params: {
    sessionId: string;
    strategyId?: StrategyId;
    mode?: ReplayMode;
    verifyEachStep?: boolean;
    interStepDelayMs?: number;
    maxSteps?: number;
    onStep?: (step: ReplayStepRecord, run: ReplayRun) => void;
  }): Promise<ReplayRun> {
    const sessionId = params.sessionId.trim();
    const strategyId = (params.strategyId ?? "hybrid") as StrategyId;
    const mode: ReplayMode = params.mode ?? "simulate";
    const verifyEachStep = params.verifyEachStep ?? mode === "production";
    const interStepDelayMs = Math.max(0, Math.min(10_000, params.interStepDelayMs ?? 250));
    const maxSteps = Math.max(1, Math.min(5_000, params.maxSteps ?? 5_000));

    const recordingSummary = this.deps.store.summarize(sessionId);
    if (!recordingSummary) throw new Error(`recording '${sessionId}' not found`);

    const strategy = getStrategy(strategyId);
    if (!strategy) throw new Error(`unknown strategy '${strategyId}'`);

    const events = this.deps.store.readEvents(sessionId, { limit: maxSteps });
    if (events.length === 0) throw new Error(`recording '${sessionId}' has no events`);

    const runId = newRunId();
    const run: ReplayRun = {
      id: runId,
      sessionId,
      strategyId,
      mode,
      status: "pending",
      steps: [],
      createdAtISO: new Date().toISOString(),
    };
    this.runs.set(runId, run);

    this.deps.log?.append({
      action: "replay.start",
      target: `session:${sessionId}`,
      result: "ok",
      detail: `strategy=${strategyId} mode=${mode} steps=${events.length}`,
      source: "replay-engine",
      extra: { runId, verifyEachStep },
    });

    run.status = "running";
    run.startedAtISO = new Date().toISOString();

    try {
      for (let i = 0; i < events.length; i++) {
        if (run.abortRequested) {
          run.status = "aborted";
          break;
        }
        const evt = events[i]!;
        const step = await this.executeStep(evt, i, strategy, sessionId, mode, verifyEachStep);
        run.steps.push(step);
        params.onStep?.(step, run);
        if (step.error) {
          run.status = "error";
          break;
        }
        if (interStepDelayMs > 0 && i < events.length - 1) {
          await sleep(interStepDelayMs);
        }
      }
      if (run.status === "running") run.status = "done";
    } catch (e) {
      run.status = "error";
      this.deps.log?.append({
        action: "replay.crash",
        target: `session:${sessionId}`,
        result: "error",
        detail: (e as Error).message,
        source: "replay-engine",
      });
    } finally {
      run.finishedAtISO = new Date().toISOString();
      this.deps.log?.append({
        action: "replay.end",
        target: `session:${sessionId}`,
        result: run.status === "done" ? "ok" : run.status === "aborted" ? "warn" : "error",
        detail: `${run.steps.length} steps, status=${run.status}`,
        source: "replay-engine",
        extra: { runId },
      });
    }
    return run;
  }

  private async executeStep(
    evt: RecordingEvent,
    idx: number,
    strategy: ReplayStrategy,
    sessionId: string,
    mode: ReplayMode,
    verifyEachStep: boolean,
  ): Promise<ReplayStepRecord> {
    const start = performance.now();
    let resolved: ResolvedAction;
    let dispatched = false;
    let verification: VerificationResult | undefined;
    let error: string | undefined;
    let preScreenshotPath: string | null = null;

    const recordingDir = this.deps.store.sessionDir(sessionId);

    try {
      // Load enriched recorded event with UIA element + window context if present.
      const enriched = enrichEvent(evt, recordingDir);
      const live = await this.deps.liveContextProvider();
      preScreenshotPath = live.screenshotPath;

      const ctx: StrategyContext = {
        recorded: enriched,
        live,
        recordingDir,
        dryRun: mode === "simulate",
      };
      resolved = await strategy.resolve(ctx);

      if (resolved.kind === "skip") {
        // Don't dispatch.
      } else if (mode === "simulate") {
        // Log only.
        dispatched = false;
      } else {
        const r = await this.deps.actionDispatcher(resolved);
        dispatched = r.ok;
        if (!r.ok) error = r.error;
      }

      if (verifyEachStep && resolved.kind !== "skip" && dispatched) {
        const post = await this.deps.liveContextProvider();
        const policy = (resolved as { verifyPolicy?: unknown }).verifyPolicy as
          | undefined
          | NonNullable<Parameters<typeof verifyPostAction>[0]["policy"]>;
        verification = await verifyPostAction({
          policy,
          preScreenshotPath,
          postLive: post,
        });
        if (!verification.ok) {
          error = `verification failed: ${verification.detail}`;
        }
      }
    } catch (e) {
      resolved = { kind: "skip", reason: `engine error: ${(e as Error).message}` };
      error = (e as Error).message;
    }

    return {
      index: idx,
      recordedKind: evt.kind,
      resolved,
      verification,
      dispatched,
      error,
      atISO: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

function enrichEvent(evt: RecordingEvent, recordingDir: string): RecordingEvent {
  // If the event referenced a UIA snapshot, pull the foreground element
  // bbox closest to the recorded mouse position so uia-grounded can use it.
  if (!evt.pos || !evt.uia) return evt;
  const uiaFile = path.join(recordingDir, evt.uia);
  if (!fs.existsSync(uiaFile)) return evt;
  try {
    const raw = JSON.parse(fs.readFileSync(uiaFile, "utf8")) as { nodes?: LiveUiaNode[] };
    if (!raw.nodes || raw.nodes.length === 0) return evt;
    let best: { node: LiveUiaNode; dist: number } | null = null;
    for (const n of raw.nodes) {
      if (!n.bbox) continue;
      const cx = n.bbox.x + Math.floor(n.bbox.w / 2);
      const cy = n.bbox.y + Math.floor(n.bbox.h / 2);
      const dx = cx - evt.pos.x;
      const dy = cy - evt.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (!best || d < best.dist) best = { node: n, dist: d };
    }
    if (!best) return evt;
    return {
      ...evt,
      // `element` is consumed by the uia_grounded strategy.
      ...(({
        element: {
          automationId: best.node.automationId,
          name: best.node.name,
          controlType: best.node.controlType,
        },
      }) as Partial<RecordingEvent>),
    };
  } catch {
    return evt;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newRunId(): string {
  RUN_COUNTER = (RUN_COUNTER + 1) & 0xffffff;
  const tick = Math.floor(performance.now()).toString(36);
  const counter = RUN_COUNTER.toString(36).padStart(4, "0");
  return `rr-${process.pid}-${tick}-${counter}`;
}

/**
 * Build a default LiveContextProvider that talks to the Lumina Windows
 * Bridge. Screenshot via /screenshot, UIA via the recorder's own uia
 * snapshot (best-effort — we re-use uia_tree.py through the Bridge if
 * available), windows via /window_control list.
 */
export function defaultLiveContextProvider(bridgeUrl: string): LiveContextProvider {
  const base = bridgeUrl.replace(/\/+$/, "");
  return async () => {
    const result: LiveContext = {
      screenshotPath: null,
      uiaNodes: null,
      windows: [],
    };
    if (typeof fetch !== "function") return result;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4_000);
      const r = await fetch(`${base}/screenshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        const body = (await r.json()) as { path?: string };
        if (typeof body.path === "string") {
          (result as { screenshotPath: string | null }).screenshotPath = body.path;
        }
      }
    } catch {
      /* offline-safe */
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3_000);
      const r = await fetch(`${base}/window_control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        const body = (await r.json()) as { windows?: unknown };
        if (Array.isArray(body.windows)) {
          (result as { windows: LiveContext["windows"] }).windows =
            body.windows.map((w) => {
              const obj = w as { title?: string; pid?: number; process?: string };
              return {
                title: String(obj.title ?? ""),
                pid: Number(obj.pid ?? 0),
                process: String(obj.process ?? ""),
              };
            });
        }
      }
    } catch {
      /* ignore */
    }
    return result;
  };
}

/**
 * Build a default ActionDispatcher that calls /input_control on the
 * Bridge. Honors the foreground app allowlist that the Bridge already
 * enforces.
 */
export function defaultActionDispatcher(params: {
  bridgeUrl: string;
  allowedApps: string[];
}): ActionDispatcher {
  const base = params.bridgeUrl.replace(/\/+$/, "");
  return async (action: ResolvedAction) => {
    if (action.kind === "skip") return { ok: true };
    if (typeof fetch !== "function") return { ok: false, error: "fetch unavailable" };
    if (action.kind === "wait") {
      await new Promise((r) => setTimeout(r, action.ms));
      return { ok: true };
    }
    const payload = toBridgePayload(action, params.allowedApps);
    if (!payload) return { ok: false, error: `unsupported action kind: ${(action as { kind: string }).kind}` };
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6_000);
      const r = await fetch(`${base}/input_control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!r.ok) return { ok: false, error: `bridge ${r.status}` };
      const body = (await r.json()) as { ok?: boolean; error?: string };
      return { ok: body.ok === true, error: body.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
}

function toBridgePayload(action: ResolvedAction, allowedApps: string[]): Record<string, unknown> | null {
  if (action.kind === "mouse_click") {
    return {
      action: "mouse_click",
      x: action.x,
      y: action.y,
      button: action.button,
      clicks: action.clicks,
      allowedApps,
    };
  }
  if (action.kind === "mouse_move") {
    return { action: "mouse_move", x: action.x, y: action.y, allowedApps };
  }
  if (action.kind === "type_text") {
    return { action: "type_text", text: action.text, allowedApps };
  }
  if (action.kind === "key_press") {
    return { action: "key_press", keys: action.keys, allowedApps };
  }
  return null;
}
