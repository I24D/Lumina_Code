/**
 * Local PowerShell runner (Phase 6).
 *
 * Same shape as `lumina-observation/utils/powershell.ts` but kept locally
 * so this extension is self-contained. Only used for queries (foreground
 * process) and for SendKeys / mouse_event when an action is allowed.
 *
 * We always pass user input through PowerShell as $arg variables via
 * `-EncodedCommand` to avoid quoting bugs. The argument string is encoded
 * as base64 UTF-16LE which PowerShell decodes automatically.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

export type PsResult<T> = {
  readonly ok: boolean;
  readonly data: T | null;
  readonly error?: string;
};

function encodeUtf16LeBase64(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

export async function runPowerShellJson<T = unknown>(
  command: string,
  timeoutMs = 10_000,
): Promise<PsResult<T>> {
  if (!IS_WIN) {
    return { ok: false, data: null, error: "Only available on Windows" };
  }
  const wrapped = `& { ${command} } | ConvertTo-Json -Depth 6 -Compress`;
  const encoded = encodeUtf16LeBase64(wrapped);
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      },
    );
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

export async function runPowerShellVoid(command: string, timeoutMs = 10_000): Promise<PsResult<null>> {
  if (!IS_WIN) {
    return { ok: false, data: null, error: "Only available on Windows" };
  }
  const encoded = encodeUtf16LeBase64(command);
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1 * 1024 * 1024,
      },
    );
    return { ok: true, data: null };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
