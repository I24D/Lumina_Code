/**
 * python.ts — Helper to run Python sidecars from the cognitive OS extension.
 *
 * Picks the interpreter in this order:
 *   1. LUMINA_PYTHON env var (from c:/I24D_WhatsApp/.env)
 *   2. `python` on PATH (Windows default)
 *   3. `python3` on PATH (POSIX default)
 *
 * Sidecar scripts live in:
 *   Lumina_PC/Open_PC/extensions/lumina-cognitive-os/sidecars/<name>.py
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLuminaEnvVar } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = path.resolve(here, "../../sidecars");
const DEFAULT_WINDOWS_SIDECAR_ROOT =
  "C:\\I24D_WhatsApp\\Lumina_PC\\Open_PC\\extensions\\lumina-cognitive-os\\sidecars";

export type PyResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly error?: string;
};

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const version = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return false;
  }
}

function windowsPathToWslExecutable(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/gu, "/")}`;
}

function isWindowsPython(command: string): boolean {
  return /\.exe$/iu.test(command) || /\/mnt\/[a-z]\//iu.test(command);
}

export function pickPython(): string {
  const explicit = getLuminaEnvVar("LUMINA_PYTHON");
  if (explicit) return isWsl() ? windowsPathToWslExecutable(explicit) : explicit;
  return process.platform === "win32" ? "python" : "python3";
}

function sidecarPath(sidecarName: string, pythonCommand: string): string {
  if (isWsl() && isWindowsPython(pythonCommand)) {
    return path.win32.join(
      process.env.LUMINA_COGNITIVE_OS_WINDOWS_SIDECAR_ROOT ?? DEFAULT_WINDOWS_SIDECAR_ROOT,
      `${sidecarName}.py`,
    );
  }
  return path.join(SIDECAR_ROOT, `${sidecarName}.py`);
}

/**
 * Resolve the on-disk path of a sidecar script for the python that will run it.
 * When the gateway runs in WSL but uses the Windows python (LUMINA_PYTHON), the
 * script must be a Windows path (C:\...) the Windows python can read — not a
 * WSL /root/... path. Long-lived subprocess managers (e.g. perception) use this.
 */
export function resolveSidecarScriptPath(sidecarName: string): string {
  return sidecarPath(sidecarName, pickPython());
}

export async function runPythonSidecar(
  sidecarName: string,
  args: readonly string[] = [],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<PyResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const python = pickPython();
  const scriptPath = sidecarPath(sidecarName, python);

  return new Promise((resolve) => {
    const child = spawn(python, [scriptPath, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        stdout,
        stderr,
        code: -1,
        error: `Python sidecar ${sidecarName} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, code: -1, error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: (code ?? -1) === 0, stdout, stderr, code: code ?? -1 });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

export async function runPythonSidecarJson<T = unknown>(
  sidecarName: string,
  args: readonly string[] = [],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string; stderr?: string }> {
  const r = await runPythonSidecar(sidecarName, args, opts);
  if (!r.ok) {
    return { ok: false, error: r.error ?? r.stderr ?? `exit ${r.code}`, stderr: r.stderr };
  }
  const text = r.stdout.trim();
  if (text.length === 0) return { ok: true, data: null as unknown as T };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse Python JSON output: ${(err as Error).message}`,
      stderr: r.stderr,
    };
  }
}

export const SIDECAR_DIR = SIDECAR_ROOT;
