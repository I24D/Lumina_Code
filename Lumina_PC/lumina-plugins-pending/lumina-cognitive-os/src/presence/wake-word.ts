/**
 * wake-word.ts — Tool + background daemon for the wake-word listener.
 *
 * Tool `lumina_wake_word`:
 *   - action="status"  → ok + whether the daemon is alive
 *   - action="probe"   → spawns the Python sidecar with --once and
 *                        returns the first detection (test path)
 *   - action="start"   → launches the long-running daemon
 *   - action="stop"    → kills the daemon
 *
 * When a detection arrives, the daemon writes a JSON line that the
 * presence layer reads and translates into a `voice.session.start` event
 * so Start Talk turns on automatically.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { getLuminaEnvVar } from "../env.js";
import { runPythonSidecar } from "../shared/python.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = path.resolve(here, "../../sidecars/wake_word.py");

export type WakeListener = (detection: {
  model: string;
  score: number;
  atISO: string;
}) => void;

export class WakeWordDaemon {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners = new Set<WakeListener>();

  constructor(
    private readonly config: { model: string; threshold: number },
  ) {}

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  on(listener: WakeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): { ok: boolean; error?: string } {
    if (this.isRunning()) return { ok: true };
    const py = getLuminaEnvVar("LUMINA_PYTHON") ?? (process.platform === "win32" ? "python" : "python3");
    try {
      this.proc = spawn(
        py,
        [SIDECAR_PATH, "--model", this.config.model, "--threshold", String(this.config.threshold)],
        { windowsHide: true },
      );
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    let buffer = "";
    this.proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as {
            kind?: string;
            model?: string;
            score?: number;
            atISO?: string;
          };
          if (obj.kind === "detected" && obj.model && typeof obj.score === "number" && obj.atISO) {
            for (const l of this.listeners) {
              try {
                l({ model: obj.model, score: obj.score, atISO: obj.atISO });
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
    });
    this.proc.on("exit", () => {
      this.proc = null;
    });
    return { ok: true };
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

export function createWakeWordTool(daemon: WakeWordDaemon): AnyAgentTool {
  return {
    name: "lumina_wake_word",
    label: "Lumina Wake Word",
    description:
      "Controls the wake-word listener (default model: hey_jarvis_v0.1 via openwakeword). " +
      "Actions: status, probe (one-shot test), start (launch daemon), stop. When the daemon detects the wake " +
      "word the presence layer auto-starts a Start Talk session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("probe"),
        Type.Literal("start"),
        Type.Literal("stop"),
      ]),
    }),
    async execute(_id, params) {
      const action = params.action;
      if (action === "status") {
        return jsonResult({ ok: true, running: daemon.isRunning() });
      }
      if (action === "start") {
        const r = daemon.start();
        return jsonResult({ ok: r.ok, error: r.error, running: daemon.isRunning() });
      }
      if (action === "stop") {
        daemon.stop();
        return jsonResult({ ok: true, running: daemon.isRunning() });
      }
      if (action === "probe") {
        const r = await runPythonSidecar("wake_word", ["--once"], { timeoutMs: 60_000 });
        return jsonResult({
          ok: r.ok,
          stderr: r.stderr.length > 0 ? r.stderr : undefined,
          firstDetection: r.stdout.trim().split("\n").pop() ?? null,
        });
      }
      throw new ToolInputError(`unknown action: ${String(action)}`);
    },
  };
}
