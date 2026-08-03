/**
 * recorder-tool.ts — Agent tools for the LfD Recorder.
 *
 *   lumina_recorder_start    open a new session
 *   lumina_recorder_stop     close it, flush JSONL, return stats
 *   lumina_recorder_pause    halt event capture without closing the session
 *   lumina_recorder_resume   resume capturing
 *   lumina_recorder_status   inspect the current session + sidecar state
 *   lumina_recorder_list     enumerate stored recordings
 *   lumina_recorder_get      metadata + a slice of events for one recording
 *   lumina_recorder_delete   remove a recording from disk
 *
 * Privacy: every start emits a Windows toast via the Bridge so the user
 * can SEE that recording is on. Stop emits another. Recording metadata
 * also lands in the ActionLog. If LUMINA_RECORDER_REDACT=1 is set,
 * stopping ALSO runs scrubbing in-place.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { ActionLogStore } from "../memory/action-log.js";
import type { RecorderProcess } from "./recorder-process.js";
import { getLuminaEnvVar } from "../env.js";
import { defaultScrubbingPolicy } from "./scrubbing.js";

type ToastDispatcher = (params: { title: string; message: string }) => Promise<void>;

export type RecorderToolDeps = {
  readonly recorder: RecorderProcess;
  readonly log: ActionLogStore | null;
  readonly toastDispatcher?: ToastDispatcher;
};

function defaultToastDispatcher(): ToastDispatcher {
  const url = (process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
  return async (params) => {
    if (typeof fetch !== "function") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(`${url}/notify_toast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch {
      /* offline-safe */
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createRecorderStartTool(deps: RecorderToolDeps): AnyAgentTool {
  const dispatcher = deps.toastDispatcher ?? defaultToastDispatcher();
  return {
    name: "lumina_recorder_start",
    label: "Lumina Recorder — Start",
    description:
      "Begins a new Lumina LfD recording session. Captures mouse + keyboard events, a screenshot per " +
      "event, and a Windows UI Automation snapshot per event when on Windows. Emits a Windows toast so " +
      "the user knows recording is active. ONE session at a time — call _stop first to start another.",
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({ maxLength: 200, description: "Human-readable label for the demo ('organize downloads')." }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("events"), Type.Literal("screencast")], {
          default: "events",
          description: "`events`: one frame per real event. `screencast`: also tick a frame every 1/fpsHint seconds.",
        }),
      ),
      captureUia: Type.Optional(
        Type.Boolean({ default: true, description: "Snapshot the Windows UIA tree on each event." }),
      ),
      fpsHint: Type.Optional(
        Type.Number({ minimum: 0.5, maximum: 30, default: 5, description: "Only used when mode=screencast." }),
      ),
      sessionId: Type.Optional(
        Type.String({ maxLength: 64, description: "Optional fixed session id; auto-generated otherwise." }),
      ),
    }),
    async execute(_id, params) {
      const result = await deps.recorder.start({
        mode: (params.mode as "events" | "screencast") ?? "events",
        label: params.label,
        captureUia: params.captureUia ?? true,
        fpsHint: params.fpsHint,
        sessionId: params.sessionId,
      });
      if (!result.ok) {
        deps.log?.append({
          action: "recorder.start.failed",
          target: params.sessionId ?? "(auto)",
          result: "error",
          detail: result.error,
          source: "recorder",
        });
        return jsonResult({ ok: false, error: result.error });
      }
      deps.log?.append({
        action: "recorder.start",
        target: `session:${result.sessionId}`,
        result: "ok",
        detail: params.label ?? null ?? undefined,
        source: "recorder",
        extra: { mode: params.mode ?? "events", captureUia: params.captureUia ?? true },
      });
      await dispatcher({
        title: "Lumina Recorder",
        message: `Grabando sesión '${result.sessionId}'. Diré 'detener grabación' para parar.`,
      }).catch(() => undefined);
      return jsonResult({
        ok: true,
        sessionId: result.sessionId,
        sessionDir: result.sessionDir,
        mode: params.mode ?? "events",
      });
    },
  };
}

export function createRecorderStopTool(deps: RecorderToolDeps): AnyAgentTool {
  const dispatcher = deps.toastDispatcher ?? defaultToastDispatcher();
  return {
    name: "lumina_recorder_stop",
    label: "Lumina Recorder — Stop",
    description:
      "Stops the active recording, flushes the events.jsonl, finalizes meta.json, runs scrubbing if " +
      "LUMINA_RECORDER_REDACT=1, and emits a Windows toast confirming the session ended.",
    parameters: Type.Object({}),
    async execute() {
      const state = deps.recorder.getState();
      const sessionId =
        state.kind === "recording" || state.kind === "paused" ? state.sessionId : null;
      const result = await deps.recorder.stop();
      if (!result.ok) {
        deps.log?.append({
          action: "recorder.stop.failed",
          target: sessionId ?? "(none)",
          result: "error",
          detail: result.error,
          source: "recorder",
        });
        return jsonResult({ ok: false, error: result.error });
      }
      let redactions = 0;
      const redactRequested = (getLuminaEnvVar("LUMINA_RECORDER_REDACT") ?? "0").trim() === "1";
      if (sessionId && redactRequested) {
        const r = deps.recorder.store.scrub(sessionId, defaultScrubbingPolicy());
        if (r.ok) redactions = r.redactions;
      }
      const summary = sessionId ? deps.recorder.store.summarize(sessionId) : null;
      deps.log?.append({
        action: "recorder.stop",
        target: sessionId ?? "(none)",
        result: "ok",
        detail: `${result.stats.events} events in ${result.stats.durationMs}ms`,
        source: "recorder",
        extra: { redactions, sessionDir: result.stats.sessionDir },
      });
      await dispatcher({
        title: "Lumina Recorder",
        message: `Sesión guardada: ${result.stats.events} eventos.`,
      }).catch(() => undefined);
      return jsonResult({
        ok: true,
        stats: result.stats,
        redactions,
        summary,
      });
    },
  };
}

export function createRecorderPauseTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_pause",
    label: "Lumina Recorder — Pause",
    description: "Pauses event capture without closing the session. Use to type a password without recording it.",
    parameters: Type.Object({}),
    async execute() {
      const r = await deps.recorder.pause();
      return jsonResult({ ok: r.ok, error: r.error });
    },
  };
}

export function createRecorderResumeTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_resume",
    label: "Lumina Recorder — Resume",
    description: "Resumes a paused recording.",
    parameters: Type.Object({}),
    async execute() {
      const r = await deps.recorder.resume();
      return jsonResult({ ok: r.ok, error: r.error });
    },
  };
}

export function createRecorderStatusTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_status",
    label: "Lumina Recorder — Status",
    description: "Returns the current recorder state (sidecar pid, active session if any).",
    parameters: Type.Object({}),
    async execute() {
      const state = deps.recorder.getState();
      const rootDir = deps.recorder.store.rootDir;
      return jsonResult({
        ok: true,
        state,
        rootDir,
        redactOnStop: (getLuminaEnvVar("LUMINA_RECORDER_REDACT") ?? "0").trim() === "1",
      });
    },
  };
}

export function createRecorderListTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_list",
    label: "Lumina Recorder — List",
    description: "Lists all recorded sessions stored under the recordings directory, newest first.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 50 })),
    }),
    async execute(_id, p) {
      const list = deps.recorder.store.list().slice(0, p.limit ?? 50);
      return jsonResult({
        ok: true,
        rootDir: deps.recorder.store.rootDir,
        count: list.length,
        recordings: list,
      });
    },
  };
}

export function createRecorderGetTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_get",
    label: "Lumina Recorder — Get",
    description:
      "Returns metadata + a slice of events for a stored recording. Use `offset` and `limit` to paginate " +
      "(large recordings can have thousands of events).",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 80 }),
      offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1_000, default: 100 })),
    }),
    async execute(_id, p) {
      const id = p.sessionId?.trim();
      if (!id) throw new ToolInputError("sessionId is required");
      const summary = deps.recorder.store.summarize(id);
      if (!summary) {
        return jsonResult({ ok: false, error: `recording '${id}' not found` });
      }
      const events = deps.recorder.store.readEvents(id, { offset: p.offset ?? 0, limit: p.limit ?? 100 });
      return jsonResult({
        ok: true,
        summary,
        offset: p.offset ?? 0,
        limit: p.limit ?? 100,
        events,
      });
    },
  };
}

export function createRecorderDeleteTool(deps: RecorderToolDeps): AnyAgentTool {
  return {
    name: "lumina_recorder_delete",
    label: "Lumina Recorder — Delete",
    description:
      "Permanently deletes a stored recording (folder + all screenshots/UIA snapshots). HIGH_RISK — " +
      "the calling agent should confirm with the user before invoking.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 80 }),
      confirm: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, p) {
      const id = p.sessionId?.trim();
      if (!id) throw new ToolInputError("sessionId is required");
      if (!p.confirm) {
        return jsonResult({
          ok: false,
          refused: "needs-confirmation",
          hint: "Re-call with confirm: true after the user explicitly approved deletion.",
          sessionId: id,
        });
      }
      const summary = deps.recorder.store.summarize(id);
      const ok = deps.recorder.store.delete(id);
      deps.log?.append({
        action: "recorder.delete",
        target: id,
        result: ok ? "ok" : "error",
        source: "recorder",
        extra: { sizeBytes: summary?.sizeBytes ?? null },
      });
      return jsonResult({ ok, sessionId: id });
    },
  };
}
