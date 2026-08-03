/**
 * powershell.ts — Minimal PowerShell runner for Windows tooling.
 *
 * Mirrors the pattern used by lumina-pc/utils/powershell.ts but is self
 * contained so this extension has no internal deps on its sibling.
 * All commands are sent over -EncodedCommand to avoid quoting drama.
 */
import { spawn } from "node:child_process";
import { canRunWindowsHostTools } from "./platform.js";

export type PsResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly error?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export function psEscape(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export async function runPowerShell(
  script: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PsResult> {
  // Works on Windows directly AND on WSL via powershell.exe interop.
  if (!canRunWindowsHostTools()) {
    return {
      ok: false,
      stdout: "",
      stderr: "PowerShell requires Windows or WSL (powershell.exe over interop).",
      code: -1,
    };
  }
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodeCommand(script),
      ],
      { windowsHide: true },
    );

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
        error: `PowerShell timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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
      resolve({
        ok: (code ?? -1) === 0,
        stdout,
        stderr,
        code: code ?? -1,
      });
    });
  });
}

export async function runPowerShellJson<T = unknown>(
  script: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const full = `${script}\n` +
    `| ConvertTo-Json -Depth 8 -Compress`;
  const r = await runPowerShell(full, timeoutMs);
  if (!r.ok) {
    return { ok: false, error: r.error ?? r.stderr ?? `exit ${r.code}` };
  }
  const text = r.stdout.trim();
  if (text.length === 0) {
    return { ok: true, data: null as unknown as T };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse PowerShell JSON output: ${(err as Error).message}`,
    };
  }
}
