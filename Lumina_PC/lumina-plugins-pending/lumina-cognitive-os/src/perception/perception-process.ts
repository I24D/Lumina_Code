/**
 * perception-process.ts — Manager for the long-lived `perception.py` sidecar.
 *
 * Owns the subprocess lifecycle (spawn / pause / resume / shutdown) and
 * parses its stdout NDJSON stream into typed events delivered to a
 * pub/sub bus.
 *
 * One sidecar per gateway. Multiple subscribers (Operative daemon, agent
 * tools, dev console) consume from the bus.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pickPython, resolveSidecarScriptPath } from "../shared/python.js";

export type PerceptionEvent =
  | { kind: "start"; atISO: string; fps: number; monitor: number; threshold: number }
  | { kind: "frame"; atISO: string; seq: number; changedRatio: number; path: string; size?: [number, number] }
  | { kind: "foreground"; atISO: string; process: string; title: string; pid: number }
  | { kind: "heartbeat"; atISO: string; quietForSec: number }
  | { kind: "error"; atISO: string; message: string; trace?: string }
  | { kind: "shutdown"; atISO: string };

export type PerceptionStatus = {
  readonly running: boolean;
  readonly pid: number | null;
  readonly fps: number;
  readonly threshold: number;
  readonly paused: boolean;
  readonly saveFrames: boolean;
  readonly outDir: string;
  readonly startedAtISO?: string;
  readonly stoppedAtISO?: string;
  readonly lastEventAtISO?: string;
  readonly eventCount: number;
};

export type PerceptionProcessOptions = {
  readonly pythonExe?: string;
  readonly scriptPath?: string;
  readonly outDir?: string;
  readonly fps?: number;
  readonly threshold?: number;
  readonly saveFrames?: boolean;
  readonly heartbeatSec?: number;
};

const DEFAULT_SCRIPT = path.resolve(
  // From src/perception/ up to extension root, into sidecars/.
  process.cwd(),
  "extensions/lumina-cognitive-os/sidecars/perception.py",
);

export interface PerceptionBus {
  on(listener: (ev: PerceptionEvent) => void): () => void;
  emit(ev: PerceptionEvent): void;
  recent(limit?: number): PerceptionEvent[];
}

export function createPerceptionBus(capacity = 200): PerceptionBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  const ring: PerceptionEvent[] = [];
  return {
    on(listener) {
      ee.on("event", listener);
      return () => ee.off("event", listener);
    },
    emit(ev) {
      ring.push(ev);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
      ee.emit("event", ev);
    },
    recent(limit = 50) {
      return ring.slice(-Math.max(1, Math.min(capacity, limit)));
    },
  };
}

export class PerceptionProcess {
  private readonly bus: PerceptionBus;
  private readonly opts: Required<PerceptionProcessOptions>;
  private desiredFps: number;
  private desiredThreshold: number;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: {
    running: boolean;
    pid: number | null;
    fps: number;
    threshold: number;
    paused: boolean;
    startedAtISO?: string;
    stoppedAtISO?: string;
    lastEventAtISO?: string;
    eventCount: number;
  };
  private stdoutBuffer = "";

  constructor(bus: PerceptionBus, options: PerceptionProcessOptions = {}) {
    this.bus = bus;
    this.opts = {
      pythonExe: options.pythonExe ?? pickPython(),
      scriptPath: options.scriptPath ?? (process.env.LUMINA_PERCEPTION_SCRIPT ?? resolveSidecarScriptPath("perception") ?? DEFAULT_SCRIPT),
      outDir: options.outDir ?? "",
      fps: options.fps ?? 2,
      threshold: options.threshold ?? 0.01,
      saveFrames: options.saveFrames ?? false,
      heartbeatSec: options.heartbeatSec ?? 30,
    };
    this.desiredFps = this.opts.fps;
    this.desiredThreshold = this.opts.threshold;
    this.status = {
      running: false,
      pid: null,
      fps: this.opts.fps,
      threshold: this.opts.threshold,
      paused: false,
      eventCount: 0,
    };
  }

  isRunning(): boolean {
    return this.status.running;
  }

  getStatus(): PerceptionStatus {
    return {
      running: this.status.running,
      pid: this.status.pid,
      fps: this.status.fps,
      threshold: this.status.threshold,
      paused: this.status.paused,
      saveFrames: this.opts.saveFrames,
      outDir: this.opts.outDir,
      startedAtISO: this.status.startedAtISO,
      stoppedAtISO: this.status.stoppedAtISO,
      lastEventAtISO: this.status.lastEventAtISO,
      eventCount: this.status.eventCount,
    };
  }

  start(): { ok: boolean; error?: string } {
    if (this.status.running) {
      return { ok: false, error: "already_running" };
    }
    const args = [
      "-u",
      this.opts.scriptPath,
      "--fps",
      String(this.desiredFps),
      "--threshold",
      String(this.desiredThreshold),
      "--heartbeat-sec",
      String(this.opts.heartbeatSec),
    ];
    const latestStatePath = process.env.LUMINA_PERCEPTION_LATEST_STATE;
    if (latestStatePath) {
      args.push("--latest-state", latestStatePath);
    }
    if (this.opts.outDir) {
      args.push("--out-dir", this.opts.outDir);
    }
    if (this.opts.saveFrames) {
      args.push("--save-frames");
    }
    try {
      this.proc = spawn(this.opts.pythonExe, args, {
        windowsHide: true,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    this.status.running = true;
    this.status.pid = this.proc.pid ?? null;
    this.status.startedAtISO = new Date().toISOString();
    this.status.paused = false;
    this.status.fps = this.desiredFps;
    this.status.threshold = this.desiredThreshold;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => undefined);
    this.proc.on("exit", () => this.onExit());
    this.proc.on("error", (e) => {
      this.bus.emit({ kind: "error", atISO: new Date().toISOString(), message: `process_error: ${e.message}` });
    });
    return { ok: true };
  }

  pause(): { ok: boolean; error?: string } {
    if (!this.status.running || !this.proc) return { ok: false, error: "not_running" };
    this.proc.stdin.write(JSON.stringify({ cmd: "pause" }) + "\n");
    this.status.paused = true;
    return { ok: true };
  }

  resume(): { ok: boolean; error?: string } {
    if (!this.status.running || !this.proc) return { ok: false, error: "not_running" };
    this.proc.stdin.write(JSON.stringify({ cmd: "resume" }) + "\n");
    this.status.paused = false;
    return { ok: true };
  }

  setDesiredFps(fps: number): void {
    this.desiredFps = Math.max(0.5, Math.min(10, fps));
    if (!this.status.running) this.status.fps = this.desiredFps;
  }

  setDesiredThreshold(threshold: number): void {
    this.desiredThreshold = Math.max(0.001, Math.min(0.5, threshold));
    if (!this.status.running) this.status.threshold = this.desiredThreshold;
  }

  setFps(fps: number): { ok: boolean; error?: string } {
    const bounded = Math.max(0.5, Math.min(10, fps));
    if (!this.status.running || !this.proc) return { ok: false, error: "not_running" };
    this.proc.stdin.write(JSON.stringify({ cmd: "set_fps", fps: bounded }) + "\n");
    this.status.fps = bounded;
    return { ok: true };
  }

  setThreshold(threshold: number): { ok: boolean; error?: string } {
    const bounded = Math.max(0.001, Math.min(0.5, threshold));
    if (!this.status.running || !this.proc) return { ok: false, error: "not_running" };
    this.proc.stdin.write(JSON.stringify({ cmd: "set_threshold", r: bounded }) + "\n");
    this.status.threshold = bounded;
    return { ok: true };
  }

  shutdown(): { ok: boolean; error?: string } {
    if (!this.status.running || !this.proc) return { ok: false, error: "not_running" };
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      // pipe already closed
    }
    // Give the sidecar 800ms to exit gracefully, then kill.
    const proc = this.proc;
    setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }, 800);
    return { ok: true };
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let parsed: PerceptionEvent | null = null;
      try {
        parsed = JSON.parse(line) as PerceptionEvent;
      } catch {
        // Drop malformed lines silently — the sidecar may print diagnostics
        // on stdout during dev. Future: log to action-log with source="perception".
        continue;
      }
      if (parsed) {
        this.status.lastEventAtISO = parsed.atISO ?? new Date().toISOString();
        this.status.eventCount += 1;
        this.bus.emit(parsed);
      }
    }
  }

  private onExit(): void {
    this.status.running = false;
    this.status.stoppedAtISO = new Date().toISOString();
    this.proc = null;
    this.bus.emit({ kind: "shutdown", atISO: this.status.stoppedAtISO });
  }
}
