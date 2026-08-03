/**
 * Top process observer — picks the process holding the largest working
 * set right now. Spikes in that single number are usually what users
 * notice (Chrome eating RAM, a build process exploding, etc).
 */
import { runPowerShellJson } from "../utils/powershell.js";
import type { ProcessSummary } from "../types.js";

type RawTop = {
  Name?: string;
  Id?: number;
  WorkingSetMB?: number;
  CpuSec?: number;
};

export async function readTopProcessByRam(): Promise<ProcessSummary | null> {
  const cmd = `
    Get-Process |
      Sort-Object -Property WorkingSet64 -Descending |
      Select-Object -First 1 -Property @{N='Name';E={$_.ProcessName}},Id,
        @{N='WorkingSetMB';E={[math]::Round($_.WorkingSet64/1MB,1)}},
        @{N='CpuSec';E={[math]::Round($_.CPU,1)}}
  `;
  const r = await runPowerShellJson<RawTop>(cmd, 5_000);
  if (!r.ok || r.data === null) return null;
  const name = String(r.data.Name ?? "");
  if (!name) return null;
  return {
    name,
    pid: Number(r.data.Id ?? 0),
    workingSetMB: Number(r.data.WorkingSetMB ?? 0),
    cpuSec: Number(r.data.CpuSec ?? 0),
  };
}
