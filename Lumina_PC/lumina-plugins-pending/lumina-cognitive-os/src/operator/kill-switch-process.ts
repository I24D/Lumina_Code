/**
 * kill-switch-process.ts — Manager for the `kill_switch.py` global-hotkey
 * sidecar. Spawns it, watches its NDJSON stream, and trips the in-process
 * {@link killSwitch} the instant the user hits the panic chord (§9).
 *
 * Mirrors the lifecycle style of perception-process.ts (spawn / stdout
 * line parse / shutdown), but the sidecar is fire-and-forget: its only job
 * is to translate a global keypress into `killSwitch.engage("hotkey")`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { pickPython, resolveSidecarScriptPath } from "../shared/python.js";
import { killSwitch } from "./kill-switch.js";

const DEFAULT_SCRIPT = path.resolve(
  process.cwd(),
  "extensions/lumina-cognitive-os/sidecars/kill_switch.py",
);

export type KillSwitchProcessOptions = {
  readonly pythonExe?: string;
  readonly scriptPath?: string;
  /** Chord spec, e.g. "ctrl+alt+k" or "ctrl+alt+pause". */
  readonly keys?: string;
  /** Called on every engage event (for logging/telemetry). */
  readonly onEngage?: (chord: string) => void;
};

export type KillSwitchProcessStatus = {
  readonly running: boolean;
  readonly pid: number | null;
  readonly chord: string | null;
  readonly ready: boolean;
  readonly startedAtISO?: string;
};

export class KillSwitchProcess {
  private readonly pythonExe: string;
  private readonly scriptPath: string;
  private readonly keys: string;
  private readonly onEngage?: (chord: string) => void;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private chord: string | null = null;
  private ready = false;
  private startedAtISO?: string;

  constructor(options: KillSwitchProcessOptions = {}) {
    this.pythonExe = options.pythonExe ?? pickPython();
    this.scriptPath =
      options.scriptPath ??
      process.env.LUMINA_KILL_SWITCH_SCRIPT ??
      resolveSidecarScriptPath("kill_switch") ??
      DEFAULT_SCRIPT;
    this.keys = options.keys ?? process.env.LUMINA_KILL_SWITCH_KEYS ?? "ctrl+alt+k";
    this.onEngage = options.onEngage;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  getStatus(): KillSwitchProcessStatus {
    return {
      running: this.proc !== null,
      pid: this.proc?.pid ?? null,
      chord: this.chord,
      ready: this.ready,
      startedAtISO: this.startedAtISO,
    };
  }

  start(): { ok: boolean; error?: string } {
    if (this.proc) return { ok: false, error: "already_running" };
    try {
      this.proc = spawn(this.pythonExe, ["-u", this.scriptPath, "--keys", this.keys], {
        windowsHide: true,
      });
    } catch (e) {
      this.proc = null;
      return { ok: false, error: (e as Error).message };
    }
    this.startedAtISO = new Date().toISOString();
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => undefined);
    this.proc.on("exit", () => {
      this.proc = null;
      this.ready = false;
    });
    this.proc.on("error", () => {
      this.proc = null;
      this.ready = false;
    });
    return { ok: true };
  }

  shutdown(): { ok: boolean } {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.ready = false;
    return { ok: true };
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let event: { event?: string; chord?: string } | null = null;
      try {
        event = JSON.parse(line) as { event?: string; chord?: string };
      } catch {
        continue;
      }
      if (!event) continue;
      if (event.event === "ready") {
        this.ready = true;
        this.chord = event.chord ?? this.keys;
      } else if (event.event === "engage") {
        const chord = event.chord ?? this.keys;
        killSwitch.engage(`hotkey:${chord}`);
        this.onEngage?.(chord);
      }
    }
  }
}
