/**
 * gpu.ts — GPU discovery via Windows WMI (Win32_VideoController).
 * Returns one entry per adapter with name, driver version, VRAM and
 * current resolution. Falls back to an empty list on non-Windows.
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type GpuInfo = {
  readonly name: string;
  readonly driverVersion: string | null;
  readonly vramMB: number | null;
  readonly currentResolution: string | null;
};

type Raw = {
  Name?: string;
  DriverVersion?: string;
  AdapterRAM?: number;
  CurrentHorizontalResolution?: number;
  CurrentVerticalResolution?: number;
};

const SCRIPT = `
  Get-CimInstance Win32_VideoController |
    Select-Object Name, DriverVersion, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution
`;

export async function readGpuInfo(timeoutMs = 6_000): Promise<GpuInfo[]> {
  if (process.platform !== "win32") return [];
  const r = await runPowerShellJson<Raw | Raw[]>(SCRIPT, timeoutMs);
  if (!r.ok) return [];
  const raw = Array.isArray(r.data) ? r.data : r.data === null ? [] : [r.data];
  return raw.map((row) => {
    const w = row.CurrentHorizontalResolution ?? null;
    const h = row.CurrentVerticalResolution ?? null;
    return {
      name: row.Name ?? "unknown",
      driverVersion: row.DriverVersion ?? null,
      vramMB:
        typeof row.AdapterRAM === "number"
          ? Math.round(row.AdapterRAM / (1024 * 1024))
          : null,
      currentResolution: w && h ? `${w}x${h}` : null,
    };
  });
}
