/**
 * powershell.ts
 * Utility for running PowerShell commands.
 *
 * Works on:
 *   - Windows           → spawns `powershell.exe` in-process.
 *   - WSL               → invokes Windows-host `powershell.exe` over interop.
 *   - macOS / Linux     → returns a structured "not supported" error.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PsResult = {
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: string;
};

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}

/** True on Windows or WSL — i.e. where `powershell.exe` can be invoked. */
export function canRunPowerShell(): boolean {
  return process.platform === "win32" || isWsl();
}

const PS_BASE_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/**
 * Run a PowerShell command and return stdout/stderr.
 * Times out after `timeoutMs` milliseconds (default 15 s).
 */
export async function runPowerShell(
  command: string,
  timeoutMs = 15_000,
): Promise<PsResult> {
  if (!canRunPowerShell()) {
    return {
      stdout: "",
      stderr: "",
      ok: false,
      error: "PowerShell requires Windows or WSL (powershell.exe over interop).",
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      [...PS_BASE_ARGS, command],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? "",
      ok: false,
      error: e.message,
    };
  }
}

/**
 * Escape a string so it is safe to embed inside a PowerShell double-quoted string.
 */
export function psEscape(value: string): string {
  return value
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')
    .replace(/\n/g, "`n")
    .replace(/\r/g, "`r");
}
