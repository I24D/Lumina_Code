/**
 * Localiza la ventana de Claude App (desktop).
 *
 * Devuelve:
 *   - process info (PID, name)
 *   - window handle (HWND) y rect (x, y, w, h)
 *   - monitor en el que está visible (índice + nombre del display)
 *
 * Sirve para:
 *   - Decidir si Claude App está abierto (si no → ofrecer abrir o fallback)
 *   - Calcular coordenadas relativas para click en el chat input
 *   - Notificar al usuario "Claude App está en monitor 2"
 *
 * Implementación: PowerShell + Win32 API (GetWindowRect, MonitorFromWindow).
 * Sin dependencias nativas — same pattern que lumina-observation.
 */
import { runPowerShellJson } from "../../utils/powershell.js";

export type ClaudeAppWindow = {
  readonly processName: string;
  readonly processId: number;
  readonly windowHandle: string; // HWND as string (hex)
  readonly title: string;
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly monitor: {
    readonly index: number;
    readonly name: string;
    readonly bounds: { x: number; y: number; width: number; height: number };
    readonly isPrimary: boolean;
  };
  readonly isVisible: boolean;
  readonly isForeground: boolean;
};

type RawWindow = {
  processName?: string;
  processId?: number;
  hwnd?: string;
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  monitorIndex?: number;
  monitorName?: string;
  monitorX?: number;
  monitorY?: number;
  monitorW?: number;
  monitorH?: number;
  monitorPrimary?: boolean;
  visible?: boolean;
  foreground?: boolean;
};

const PS_SCRIPT_TEMPLATE = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public static class W {
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
      [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
      }
      [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX i);
    }
"@ -ErrorAction SilentlyContinue
  $procName = '__PROC_NAME__'
  $procs = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  if (-not $procs) { return $null }
  $proc = $procs | Sort-Object -Property StartTime -Descending | Select-Object -First 1
  $hWnd = $proc.MainWindowHandle
  $rect = New-Object W+RECT
  $gotRect = [W]::GetWindowRect($hWnd, [ref]$rect)
  $titleLen = [W]::GetWindowTextLength($hWnd)
  $sb = New-Object System.Text.StringBuilder ($titleLen + 1)
  [void][W]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $visible = [W]::IsWindowVisible($hWnd)
  $fg = [W]::GetForegroundWindow()
  # MONITOR_DEFAULTTONEAREST = 2
  $monHandle = [W]::MonitorFromWindow($hWnd, 2)
  $monInfo = New-Object W+MONITORINFOEX
  $monInfo.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($monInfo)
  $gotMon = [W]::GetMonitorInfo($monHandle, [ref]$monInfo)
  $allMons = [System.Windows.Forms.Screen]::AllScreens
  $monIdx = -1
  for ($i = 0; $i -lt $allMons.Length; $i++) {
    if ($allMons[$i].DeviceName -eq $monInfo.szDevice) { $monIdx = $i; break }
  }
  [pscustomobject]@{
    processName = $proc.ProcessName
    processId = $proc.Id
    hwnd = "0x" + $hWnd.ToInt64().ToString("X")
    title = $sb.ToString()
    x = if ($gotRect) { $rect.Left } else { 0 }
    y = if ($gotRect) { $rect.Top } else { 0 }
    w = if ($gotRect) { $rect.Right - $rect.Left } else { 0 }
    h = if ($gotRect) { $rect.Bottom - $rect.Top } else { 0 }
    monitorIndex = $monIdx
    monitorName = $monInfo.szDevice
    monitorX = if ($gotMon) { $monInfo.rcMonitor.Left } else { 0 }
    monitorY = if ($gotMon) { $monInfo.rcMonitor.Top } else { 0 }
    monitorW = if ($gotMon) { $monInfo.rcMonitor.Right - $monInfo.rcMonitor.Left } else { 0 }
    monitorH = if ($gotMon) { $monInfo.rcMonitor.Bottom - $monInfo.rcMonitor.Top } else { 0 }
    monitorPrimary = ($monInfo.dwFlags -band 1) -eq 1
    visible = $visible
    foreground = ($fg -eq $hWnd)
  }
`;

const SAFE_PROC_NAME = /^[\w-]{1,32}$/;

export async function locateClaudeApp(processName: string): Promise<ClaudeAppWindow | null> {
  if (!SAFE_PROC_NAME.test(processName)) {
    throw new Error(`Unsafe processName: "${processName}"`);
  }
  const script = PS_SCRIPT_TEMPLATE.replace("__PROC_NAME__", processName) +
    `\nAdd-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue`;
  // The script above uses System.Windows.Forms.Screen so we need it loaded;
  // PowerShell autoloads it in modern Windows, but be explicit.
  const fullScript = `Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue\n` + script;
  const r = await runPowerShellJson<RawWindow>(fullScript, 8_000);
  if (!r.ok || !r.data) return null;
  const d = r.data;
  if (!d.processName || !d.processId || !d.hwnd) return null;
  return {
    processName: String(d.processName),
    processId: Number(d.processId),
    windowHandle: String(d.hwnd),
    title: String(d.title ?? ""),
    rect: {
      x: Number(d.x ?? 0),
      y: Number(d.y ?? 0),
      width: Number(d.w ?? 0),
      height: Number(d.h ?? 0),
    },
    monitor: {
      index: Number(d.monitorIndex ?? -1),
      name: String(d.monitorName ?? ""),
      bounds: {
        x: Number(d.monitorX ?? 0),
        y: Number(d.monitorY ?? 0),
        width: Number(d.monitorW ?? 0),
        height: Number(d.monitorH ?? 0),
      },
      isPrimary: Boolean(d.monitorPrimary),
    },
    isVisible: Boolean(d.visible),
    isForeground: Boolean(d.foreground),
  };
}
