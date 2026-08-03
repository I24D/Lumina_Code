/**
 * Focus-window driver — brings a window owned by a given process to the
 * foreground. Uses WScript.Shell.AppActivate which is the most portable
 * way without P/Invoke gymnastics.
 *
 * Returns false when no window with a matching title or process is
 * found. The tool layer relays that to the caller as a structured
 * failure rather than throwing.
 */
import { runPowerShellJson } from "../utils/powershell.js";

const PS_SCRIPT_BY_PROC = `
  $name = $env:LUMINA_FOCUS_PROC
  $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object -Property StartTime -Descending |
    Select-Object -First 1
  if (-not $proc) { return [pscustomobject]@{ ok = $false; reason = "no window" } }
  $title = $proc.MainWindowTitle
  if (-not $title) { return [pscustomobject]@{ ok = $false; reason = "no title" } }
  $shell = New-Object -ComObject "Wscript.Shell"
  $ok = $shell.AppActivate($title)
  Start-Sleep -Milliseconds 80
  [pscustomobject]@{ ok = [bool]$ok; title = $title }
`;

type RawFocus = { ok?: boolean; reason?: string; title?: string };

export async function focusByProcessName(processName: string): Promise<{ ok: boolean; title?: string; reason?: string }> {
  process.env.LUMINA_FOCUS_PROC = processName.replace(/\.exe$/i, "");
  try {
    const r = await runPowerShellJson<RawFocus>(PS_SCRIPT_BY_PROC, 5_000);
    if (!r.ok || !r.data) return { ok: false, reason: r.error ?? "powershell error" };
    const ok = r.data.ok === true;
    return { ok, title: r.data.title, reason: r.data.reason };
  } finally {
    delete process.env.LUMINA_FOCUS_PROC;
  }
}
