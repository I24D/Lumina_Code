/**
 * monitors.ts — All attached displays with bounds and DPI.
 * Used by both the awareness snapshot and the multimonitor capture in vision/.
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type MonitorInfo = {
  readonly index: number;
  readonly primary: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly workingArea: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly deviceName: string;
};

type RawScreen = {
  Primary?: boolean;
  DeviceName?: string;
  Bounds?: { X?: number; Y?: number; Width?: number; Height?: number };
  WorkingArea?: { X?: number; Y?: number; Width?: number; Height?: number };
};

const SCRIPT = `
  Add-Type -AssemblyName System.Windows.Forms
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $screens | ForEach-Object {
    [pscustomobject]@{
      Primary = $_.Primary
      DeviceName = $_.DeviceName
      Bounds = [pscustomobject]@{ X = $_.Bounds.X; Y = $_.Bounds.Y; Width = $_.Bounds.Width; Height = $_.Bounds.Height }
      WorkingArea = [pscustomobject]@{ X = $_.WorkingArea.X; Y = $_.WorkingArea.Y; Width = $_.WorkingArea.Width; Height = $_.WorkingArea.Height }
    }
  }
`;

export async function readMonitors(timeoutMs = 4_000): Promise<MonitorInfo[]> {
  if (process.platform !== "win32") return [];
  const r = await runPowerShellJson<RawScreen | RawScreen[]>(SCRIPT, timeoutMs);
  if (!r.ok) return [];
  const list = Array.isArray(r.data) ? r.data : r.data === null ? [] : [r.data];
  return list.map((s, i) => ({
    index: i,
    primary: s.Primary === true,
    deviceName: s.DeviceName ?? "",
    bounds: {
      x: s.Bounds?.X ?? 0,
      y: s.Bounds?.Y ?? 0,
      w: s.Bounds?.Width ?? 0,
      h: s.Bounds?.Height ?? 0,
    },
    workingArea: {
      x: s.WorkingArea?.X ?? 0,
      y: s.WorkingArea?.Y ?? 0,
      w: s.WorkingArea?.Width ?? 0,
      h: s.WorkingArea?.Height ?? 0,
    },
  }));
}
