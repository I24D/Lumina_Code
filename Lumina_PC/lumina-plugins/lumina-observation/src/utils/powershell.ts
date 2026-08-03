/**
 * Local PowerShell runner.
 *
 * Why a local copy instead of importing from lumina-pc: cross-plugin
 * direct imports couple build outputs. Keeping the helper here means the
 * extension is self-contained and the lumina-pc plugin can change its
 * own utilities without breaking us.
 *
 * Phase 3 only uses read-only queries (`Get-*`). The runner does not
 * enforce that — callers are responsible — but the surface here is small
 * enough to audit.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === "win32";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

export type PsJsonResult<T> = {
  readonly ok: boolean;
  readonly data: T | null;
  readonly error?: string;
};

/**
 * Run a PowerShell command that produces JSON to stdout, parse it, and
 * return a typed result. We wrap callers' commands in `& { ... }` so any
 * try/catch inside still pipes its output into ConvertTo-Json.
 */
export async function runPowerShellJson<T = unknown>(
  command: string,
  timeoutMs = 10_000,
): Promise<PsJsonResult<T>> {
  if (!IS_WIN) {
    return { ok: false, data: null, error: "Only available on Windows" };
  }
  const wrapped = `& { ${command} } | ConvertTo-Json -Depth 6 -Compress`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [...PS_ARGS, wrapped], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) return { ok: true, data: null };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
