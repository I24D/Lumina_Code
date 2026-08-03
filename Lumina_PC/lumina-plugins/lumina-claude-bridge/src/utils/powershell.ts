/**
 * Local PowerShell helper.
 *
 * Self-contained per extension (no cross-plugin imports). Same pattern as
 * lumina-input-control / lumina-observation. Uses -EncodedCommand to avoid
 * quoting headaches when scripts contain `"`, `$`, etc.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

function encodeUtf16LeBase64(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

export type PsResult<T> = {
  readonly ok: boolean;
  readonly data: T | null;
  readonly error?: string;
};

export async function runPowerShellJson<T = unknown>(
  command: string,
  timeoutMs = 10_000,
): Promise<PsResult<T>> {
  if (!IS_WIN) return { ok: false, data: null, error: "Windows only" };
  const wrapped = `& { ${command} } | ConvertTo-Json -Depth 6 -Compress`;
  const encoded = encodeUtf16LeBase64(wrapped);
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    const text = stdout.trim();
    if (!text) return { ok: true, data: null };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runPowerShellVoid(command: string, timeoutMs = 10_000): Promise<PsResult<null>> {
  if (!IS_WIN) return { ok: false, data: null, error: "Windows only" };
  const encoded = encodeUtf16LeBase64(command);
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 1 * 1024 * 1024 },
    );
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}
