/**
 * recorder-process.ts — Persistent supervisor for the recorder.py sidecar.
 *
 * Unlike one-shot sidecars (uia_tree.py, omniparser.py) the recorder is
 * long-lived: TS spawns it once on the first start() call and keeps the
 * subprocess alive across many record sessions. Communication is JSONL
 * over stdin / stdout.
 *
 * Lifecycle:
 *   - lazy spawn on the first start() — subsequent starts reuse the
 *     subprocess, only sending a new {cmd: "start"}.
 *   - on TS-side process exit, the sidecar is killed via SIGTERM (it
 *     also installs its own handler so a missed signal still flushes
 *     events.jsonl).
 *   - if the sidecar dies unexpectedly (crash / SIGKILL), the supervisor
 *     marks state as "dead" and the next start() re-spawns.
 *
 * Concurrency:
 *   - At most ONE active recording session at a time. start() while
 *     active throws. UI should call stop() first.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLuminaEnvVar } from "../env.js";
import {
  generateSessionId,
  RecorderStore,
  type RecorderMode,
  type RecordingSummary,
} from "./recorder-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(here, "../../sidecars/recorder.py");

const DEFAULT_WINDOWS_SIDECAR_ROOT =
  "C:\\I24D_WhatsApp\\Lumina_PC\\Open_PC\\extensions\\lumina-cognitive-os\\sidecars";

export type RecorderProcessState =
  | { kind: "not-spawned" }
  | { kind: "ready"; pid: number }
  | { kind: "recording"; pid: number; sessionId: string; sessionDir: string; startedAtISO: string }
  | { kind: "paused";   pid: number; sessionId: string; sessionDir: string; startedAtISO: string }
  | { kind: "dead";     reason: string };

export type StartParams = {
  readonly mode?: RecorderMode;
  readonly label?: string;
  readonly captureUia?: boolean;
  readonly fpsHint?: number;
  readonly sessionId?: string;
};

type SidecarMsg = {
  event: string;
  [key: string]: unknown;
};

export class RecorderProcess {
  readonly store: RecorderStore;
  private state: RecorderProcessState = { kind: "not-spawned" };
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pendingReady: ((ok: boolean, err?: string) => void) | null = null;
  private pendingStart: ((res: { ok: true; sessionId: string; sessionDir: string } | { ok: false; error: string }) => void) | null = null;
  private pendingStop: ((res: { ok: true; stats: { events: number; durationMs: number; sessionDir: string } } | { ok: false; error: string }) => void) | null = null;

  constructor(store?: RecorderStore) {
    this.store = store ?? new RecorderStore();
  }

  getState(): RecorderProcessState {
    return this.state;
  }

  isAlive(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async ensureSpawned(): Promise<void> {
    if (this.isAlive()) return;
    const python = pickPython();
    const scriptPath = resolveSidecarPath(python);
    this.buffer = "";
    const child = spawn(python, [scriptPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    child.stdout.on("data", (b: Buffer) => this.onStdout(b));
    child.stderr.on("data", () => { /* keep silent unless debug */ });
    child.on("exit", (code) => {
      const wasRecording = this.state.kind === "recording" || this.state.kind === "paused";
      this.state = { kind: "dead", reason: `sidecar exited code=${code}` };
      this.child = null;
      const settle = (msg: string) => {
        this.pendingReady?.(false, msg);
        this.pendingReady = null;
        this.pendingStart?.({ ok: false, error: msg });
        this.pendingStart = null;
        this.pendingStop?.({ ok: false, error: msg });
        this.pendingStop = null;
      };
      settle(wasRecording ? `recorder died mid-session (${code})` : `recorder exited (${code})`);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReady = null;
        reject(new Error("recorder.py did not signal ready within 8s"));
      }, 8_000);
      this.pendingReady = (ok, err) => {
        clearTimeout(timeout);
        if (ok) resolve();
        else reject(new Error(err ?? "recorder ready failed"));
      };
    });
  }

  async start(params: StartParams = {}): Promise<{ ok: true; sessionId: string; sessionDir: string } | { ok: false; error: string }> {
    if (this.state.kind === "recording" || this.state.kind === "paused") {
      return { ok: false, error: `a session is already active: ${this.state.sessionId}` };
    }
    try {
      await this.ensureSpawned();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const sessionId = params.sessionId?.trim() || generateSessionId();
    const sessionDir = this.store.prepareNewSessionDir(sessionId);
    const cmd = {
      cmd: "start",
      sessionDir,
      sessionId,
      label: params.label ?? "",
      mode: params.mode ?? "events",
      captureUia: params.captureUia ?? true,
      fpsHint: params.fpsHint ?? 5,
    };
    return new Promise((resolve) => {
      this.pendingStart = resolve;
      try {
        this.child!.stdin.write(JSON.stringify(cmd) + "\n");
      } catch (e) {
        this.pendingStart = null;
        resolve({ ok: false, error: `stdin write failed: ${(e as Error).message}` });
      }
      // Safety timeout — sidecar should respond within 5s.
      setTimeout(() => {
        if (this.pendingStart === resolve) {
          this.pendingStart = null;
          resolve({ ok: false, error: "recorder did not confirm start within 5s" });
        }
      }, 5_000);
    });
  }

  async pause(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isAlive() || this.state.kind !== "recording") {
      return { ok: false, error: "no active recording to pause" };
    }
    this.child!.stdin.write(JSON.stringify({ cmd: "pause" }) + "\n");
    this.state = { ...this.state, kind: "paused" };
    return { ok: true };
  }

  async resume(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isAlive() || this.state.kind !== "paused") {
      return { ok: false, error: "no paused recording to resume" };
    }
    this.child!.stdin.write(JSON.stringify({ cmd: "resume" }) + "\n");
    this.state = { ...this.state, kind: "recording" };
    return { ok: true };
  }

  async stop(): Promise<{ ok: true; stats: { events: number; durationMs: number; sessionDir: string } } | { ok: false; error: string }> {
    if (!this.isAlive()) {
      return { ok: false, error: "recorder is not running" };
    }
    if (this.state.kind !== "recording" && this.state.kind !== "paused") {
      return { ok: false, error: "no active recording to stop" };
    }
    return new Promise((resolve) => {
      this.pendingStop = resolve;
      try {
        this.child!.stdin.write(JSON.stringify({ cmd: "stop" }) + "\n");
      } catch (e) {
        this.pendingStop = null;
        resolve({ ok: false, error: `stdin write failed: ${(e as Error).message}` });
      }
      setTimeout(() => {
        if (this.pendingStop === resolve) {
          this.pendingStop = null;
          resolve({ ok: false, error: "recorder did not confirm stop within 8s" });
        }
      }, 8_000);
    });
  }

  shutdown(): void {
    if (!this.isAlive()) return;
    try {
      this.child!.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.child?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 2_000);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: SidecarMsg;
      try {
        msg = JSON.parse(line) as SidecarMsg;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: SidecarMsg): void {
    switch (msg.event) {
      case "ready": {
        this.state = { kind: "ready", pid: this.child?.pid ?? -1 };
        this.pendingReady?.(true);
        this.pendingReady = null;
        return;
      }
      case "started": {
        const sessionId = String(msg.sessionId ?? "");
        const sessionDir = String(msg.sessionDir ?? "");
        const startedAtISO = String(msg.atISO ?? new Date().toISOString());
        this.state = {
          kind: "recording",
          pid: this.child?.pid ?? -1,
          sessionId,
          sessionDir,
          startedAtISO,
        };
        this.pendingStart?.({ ok: true, sessionId, sessionDir });
        this.pendingStart = null;
        return;
      }
      case "stopped": {
        const stats = (msg.stats as { events: number; durationMs: number; sessionDir: string } | undefined) ?? {
          events: 0, durationMs: 0, sessionDir: "",
        };
        this.state = { kind: "ready", pid: this.child?.pid ?? -1 };
        this.pendingStop?.({ ok: true, stats });
        this.pendingStop = null;
        return;
      }
      case "paused":
      case "resumed":
      case "tick":
      case "pong":
      case "bye": {
        return;
      }
      case "error": {
        const where = String(msg.where ?? "");
        const message = String(msg.message ?? "");
        const composed = `${where}: ${message}`;
        if (where === "import" || where === "start") {
          this.pendingReady?.(false, composed);
          this.pendingReady = null;
          this.pendingStart?.({ ok: false, error: composed });
          this.pendingStart = null;
        }
        return;
      }
      default:
        return;
    }
  }
}

function pickPython(): string {
  const explicit = getLuminaEnvVar("LUMINA_PYTHON");
  if (explicit) return isWsl() ? windowsPathToWslExecutable(explicit) : explicit;
  return process.platform === "win32" ? "python" : "python3";
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}

function windowsPathToWslExecutable(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/gu, "/")}`;
}

function resolveSidecarPath(python: string): string {
  if (isWsl() && (/\.exe$/iu.test(python) || /\/mnt\/[a-z]\//iu.test(python))) {
    return path.win32.join(
      process.env.LUMINA_COGNITIVE_OS_WINDOWS_SIDECAR_ROOT ?? DEFAULT_WINDOWS_SIDECAR_ROOT,
      "recorder.py",
    );
  }
  return SIDECAR;
}

export type ToSummaryProvider = (sessionId: string) => RecordingSummary | null;
