/**
 * battery.ts — Battery state via Win32_Battery.
 * Returns null on machines without a battery (desktops).
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type BatteryInfo = {
  readonly percent: number;
  readonly charging: boolean;
  readonly status: string;
  readonly estimatedRuntimeMin: number | null;
};

type Raw = {
  EstimatedChargeRemaining?: number;
  BatteryStatus?: number;
  EstimatedRunTime?: number;
};

// BatteryStatus codes per Microsoft:
//  1=Discharging  2=AC power  3=Fully charged  4=Low  5=Critical
//  6=Charging  7=Charging high  8=Charging low  9=Charging critical
function describe(status: number | undefined): { charging: boolean; label: string } {
  switch (status) {
    case 2:
      return { charging: true, label: "ac" };
    case 3:
      return { charging: false, label: "full" };
    case 6:
    case 7:
    case 8:
    case 9:
      return { charging: true, label: "charging" };
    case 4:
      return { charging: false, label: "low" };
    case 5:
      return { charging: false, label: "critical" };
    case 1:
    default:
      return { charging: false, label: "discharging" };
  }
}

export async function readBatteryInfo(timeoutMs = 4_000): Promise<BatteryInfo | null> {
  if (process.platform !== "win32") return null;
  const r = await runPowerShellJson<Raw | Raw[]>(
    `Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime`,
    timeoutMs,
  );
  if (!r.ok) return null;
  const raw = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!raw) return null;
  const d = describe(raw.BatteryStatus);
  // EstimatedRunTime = 71582788 means "unknown/AC" per Microsoft sentinel.
  const runtime =
    typeof raw.EstimatedRunTime === "number" && raw.EstimatedRunTime > 0 && raw.EstimatedRunTime < 1_000_000
      ? raw.EstimatedRunTime
      : null;
  return {
    percent: raw.EstimatedChargeRemaining ?? 0,
    charging: d.charging,
    status: d.label,
    estimatedRuntimeMin: runtime,
  };
}
