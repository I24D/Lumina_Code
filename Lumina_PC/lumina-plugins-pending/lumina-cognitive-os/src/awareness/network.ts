/**
 * network.ts — Live network connectivity + active adapter info.
 *
 * Combines:
 *   - Get-NetConnectionProfile  (current SSID / domain category)
 *   - Test-Connection latency to a fast anchor (1.1.1.1)
 *   - Get-NetAdapter for link speed.
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type NetworkInfo = {
  readonly online: boolean;
  readonly latencyMs: number | null;
  readonly profiles: ReadonlyArray<{ name: string; category: string }>;
  readonly adapters: ReadonlyArray<{ name: string; status: string; linkSpeedMbps: number | null }>;
};

type RawProfile = { Name?: string; NetworkCategory?: string | number };
type RawAdapter = { Name?: string; Status?: string; LinkSpeed?: string };

function parseLinkSpeed(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /([\d.]+)\s*(g|m|k)?bps/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  if (unit === "g") return n * 1000;
  if (unit === "k") return n / 1000;
  return n;
}

export async function readNetwork(timeoutMs = 6_000): Promise<NetworkInfo> {
  if (process.platform !== "win32") {
    return { online: false, latencyMs: null, profiles: [], adapters: [] };
  }
  const [profilesR, latencyR, adaptersR] = await Promise.all([
    runPowerShellJson<RawProfile | RawProfile[]>(
      `Get-NetConnectionProfile | Select-Object Name, @{Name='NetworkCategory';Expression={$_.NetworkCategory.ToString()}}`,
      timeoutMs,
    ),
    runPowerShellJson<{ ResponseTime?: number } | { ResponseTime?: number }[]>(
      `Test-Connection -ComputerName 1.1.1.1 -Count 1 -ErrorAction SilentlyContinue | Select-Object @{Name='ResponseTime';Expression={$_.Latency}}`,
      timeoutMs,
    ),
    runPowerShellJson<RawAdapter | RawAdapter[]>(
      `Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object Name, Status, LinkSpeed`,
      timeoutMs,
    ),
  ]);

  const profiles = profilesR.ok
    ? (Array.isArray(profilesR.data) ? profilesR.data : profilesR.data === null ? [] : [profilesR.data]).map(
        (p) => ({
          name: p.Name ?? "",
          category: String(p.NetworkCategory ?? ""),
        }),
      )
    : [];

  const adapters = adaptersR.ok
    ? (Array.isArray(adaptersR.data) ? adaptersR.data : adaptersR.data === null ? [] : [adaptersR.data]).map(
        (a) => ({
          name: a.Name ?? "",
          status: a.Status ?? "",
          linkSpeedMbps: parseLinkSpeed(a.LinkSpeed),
        }),
      )
    : [];

  let latencyMs: number | null = null;
  if (latencyR.ok) {
    const lr = Array.isArray(latencyR.data) ? latencyR.data[0] : latencyR.data;
    if (lr && typeof lr.ResponseTime === "number") {
      latencyMs = Math.round(lr.ResponseTime);
    }
  }
  const online = latencyMs !== null && latencyMs < 5_000;
  return { online, latencyMs, profiles, adapters };
}
