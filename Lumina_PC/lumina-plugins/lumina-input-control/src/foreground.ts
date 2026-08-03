/**
 * Foreground-window resolver.
 *
 * Reads which process owns the current foreground window. Every input
 * action consults this BEFORE executing so the allowlist decision is
 * based on the app the user is actually looking at, not on the agent's
 * cached idea of it.
 */
import { runPowerShellJson } from "./utils/powershell.js";

const PS_SCRIPT = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public static class Fg {
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
    }
"@ -ErrorAction SilentlyContinue
  $hWnd = [Fg]::GetForegroundWindow()
  if ($hWnd -eq [IntPtr]::Zero) { return [pscustomobject]@{ ok = $false } }
  $pid = 0
  [void][Fg]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if (-not $proc) { return [pscustomobject]@{ ok = $false } }
  [pscustomobject]@{
    ok = $true
    processName = $proc.ProcessName
    processId = $pid
  }
`;

type RawFg = { ok?: boolean; processName?: string; processId?: number };

export async function readForegroundProcessName(): Promise<{ name: string; pid: number } | null> {
  const r = await runPowerShellJson<RawFg>(PS_SCRIPT, 4_000);
  if (!r.ok || !r.data || r.data.ok !== true) return null;
  const name = String(r.data.processName ?? "");
  const pid = Number(r.data.processId ?? 0);
  if (!name) return null;
  return { name, pid };
}
