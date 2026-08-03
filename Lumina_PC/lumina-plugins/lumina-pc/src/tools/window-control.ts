/**
 * window-control.ts
 * Tool: lumina_window_control
 *
 * Lists open windows and controls their focus/state via PowerShell + WinAPI.
 * I24D uses this to understand what the user has open and to switch focus.
 */

import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { canRunPowerShell, psEscape, runPowerShell } from "../utils/powershell.js";
import { bridgePost, isWindowsBridgeMode } from "../utils/windows-bridge.js";

const LIST_WINDOWS_PS = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<object[]> GetAll() {
    var list = new List<object[]>();
    EnumWindows((h,_) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        var t = sb.ToString().Trim();
        if (t.Length > 0) {
          uint pid = 0; GetWindowThreadProcessId(h, out pid);
          list.Add(new object[]{ h.ToInt64(), t, pid });
        }
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$wins = [WinList]::GetAll()
$result = $wins | ForEach-Object {
  $proc = Get-Process -Id $_[2] -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    handle = $_[0]
    title  = $_[1]
    pid    = $_[2]
    process = if($proc){ $proc.ProcessName } else { "unknown" }
  }
}
$result | ConvertTo-Json -Compress
`.trim();

const FOCUS_WINDOW_PS = (title: string) =>
  `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
"@
$target = "${psEscape(title)}"
$found = $false
[WinFocus]::EnumWindows({
  param($h, $lp)
  if ([WinFocus]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinFocus]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like "*$target*") {
      [WinFocus]::ShowWindow($h, 9) | Out-Null
      [WinFocus]::SetForegroundWindow($h) | Out-Null
      $script:found = $true
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output $found
`.trim();

const APPLICATIONS = {
  browser: { target: "microsoft-edge:", displayName: "Microsoft Edge" },
  edge: { target: "microsoft-edge:", displayName: "Microsoft Edge" },
  youtube: { target: "microsoft-edge:https://www.youtube.com", displayName: "YouTube in Microsoft Edge" },
  google: { target: "microsoft-edge:https://www.google.com", displayName: "Google in Microsoft Edge" },
  chrome: { target: "chrome.exe", displayName: "Google Chrome" },
  firefox: { target: "firefox.exe", displayName: "Mozilla Firefox" },
  spotify: { target: "spotify:", displayName: "Spotify" },
  vscode: { target: "code.cmd", displayName: "Visual Studio Code" },
  notepad: { target: "notepad.exe", displayName: "Notepad" },
  calculator: { target: "calc.exe", displayName: "Calculator" },
  explorer: { target: "explorer.exe", displayName: "File Explorer" },
  settings: { target: "ms-settings:", displayName: "Windows Settings" },
  terminal: { target: "wt.exe", displayName: "Windows Terminal" },
  powershell: { target: "powershell.exe", displayName: "Windows PowerShell" },
  cmd: { target: "cmd.exe", displayName: "Command Prompt" },
} as const;

type SupportedApplication = keyof typeof APPLICATIONS;

function isSupportedApplication(value: string): value is SupportedApplication {
  return Object.hasOwn(APPLICATIONS, value);
}

const LAUNCH_APPLICATION_PS = (application: SupportedApplication) => {
  const target = APPLICATIONS[application];
  return `
$ErrorActionPreference = "Stop"
$process = Start-Process -FilePath "${psEscape(target.target)}" -PassThru
Start-Sleep -Milliseconds 500
[PSCustomObject]@{
  launched = $true
  application = "${psEscape(application)}"
  display_name = "${psEscape(target.displayName)}"
  pid = if ($process) { $process.Id } else { $null }
} | ConvertTo-Json -Compress
`.trim();
};

export function createWindowControlTool(): AnyAgentTool {
  return {
    name: "lumina_window_control",
    description:
      "Lists visible windows, focuses a window by title, or launches a supported Windows application. " +
      "Use list to see what the user has open, focus to bring a window forward, and launch when the user asks to open an application.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("focus"), Type.Literal("launch")],
        {
          description:
            "list - enumerate visible windows. focus - bring a window forward. launch - open a supported application.",
        },
      ),
      title: Type.Optional(
        Type.String({
          description: "Window title to focus (partial match). Required for focus action.",
        }),
      ),
      application: Type.Optional(
        Type.Union(Object.keys(APPLICATIONS).map((application) => Type.Literal(application)), {
          description:
            "Application to launch. Supported: browser, edge, youtube, google, chrome, firefox, spotify, vscode, notepad, calculator, explorer, settings, terminal, powershell, cmd.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (isWindowsBridgeMode()) {
        if (params.action === "focus" && !params.title?.trim()) {
          throw new ToolInputError("title is required for focus action.");
        }
        if (params.action === "launch") {
          const application = params.application?.trim().toLowerCase() ?? "";
          if (!isSupportedApplication(application)) {
            throw new ToolInputError(
              `application must be one of: ${Object.keys(APPLICATIONS).join(", ")}.`,
            );
          }
        }
        const response = await bridgePost("/window_control", {
          action: params.action,
          ...(params.title ? { title: params.title } : {}),
          ...(params.application ? { application: params.application } : {}),
        });
        return jsonResult({
          ...response,
          ok: response.ok === true,
          via: "lumina-windows-bridge",
        });
      }

      if (!canRunPowerShell()) {
        return jsonResult({
          ok: false,
          error: "lumina_window_control needs Windows or WSL (powershell.exe over interop).",
        });
      }

      if (params.action === "list") {
        const result = await runPowerShell(LIST_WINDOWS_PS, 15_000);
        if (!result.ok) {
          return jsonResult({ ok: false, error: result.error ?? result.stderr });
        }
        let windows: unknown[] = [];
        try {
          const parsed = JSON.parse(result.stdout);
          windows = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          windows = [];
        }
        return jsonResult({ ok: true, count: windows.length, windows });
      }

      if (params.action === "focus") {
        const title = params.title?.trim();
        if (!title) throw new ToolInputError("title is required for focus action.");
        const result = await runPowerShell(FOCUS_WINDOW_PS(title), 10_000);
        const focused = result.stdout.trim().toLowerCase() === "true";
        return jsonResult({
          ok: result.ok && focused,
          focused,
          title,
          error: result.ok
            ? focused
              ? undefined
              : `No window matching "${title}" found.`
            : result.error,
        });
      }

      if (params.action === "launch") {
        const application = params.application?.trim().toLowerCase() ?? "";
        if (!isSupportedApplication(application)) {
          throw new ToolInputError(
            `application must be one of: ${Object.keys(APPLICATIONS).join(", ")}.`,
          );
        }
        const result = await runPowerShell(LAUNCH_APPLICATION_PS(application), 15_000);
        if (!result.ok) {
          return jsonResult({
            ok: false,
            launched: false,
            application,
            display_name: APPLICATIONS[application].displayName,
            error: result.error ?? result.stderr,
          });
        }
        try {
          const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
          return jsonResult({ ok: true, ...parsed });
        } catch {
          return jsonResult({
            ok: true,
            launched: true,
            application,
            display_name: APPLICATIONS[application].displayName,
          });
        }
      }

      throw new ToolInputError("action must be list, focus, or launch.");
    },
  };
}
