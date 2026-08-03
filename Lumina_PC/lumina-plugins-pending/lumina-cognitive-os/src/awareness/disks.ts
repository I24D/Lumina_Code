/**
 * disks.ts — Physical disks and logical volumes via Get-PhysicalDisk and
 * Get-Volume. Surfaces health, free space and media type.
 */
import { runPowerShellJson } from "../shared/powershell.js";

export type DiskInfo = {
  readonly model: string;
  readonly mediaType: string;
  readonly health: string;
  readonly sizeGB: number;
  readonly busType: string | null;
};

export type VolumeInfo = {
  readonly driveLetter: string | null;
  readonly fileSystem: string;
  readonly label: string;
  readonly sizeGB: number;
  readonly freeGB: number;
  readonly freePct: number;
};

type RawDisk = {
  FriendlyName?: string;
  MediaType?: string;
  HealthStatus?: string;
  Size?: number;
  BusType?: string;
};

type RawVol = {
  DriveLetter?: string | null;
  FileSystem?: string;
  FileSystemLabel?: string;
  Size?: number;
  SizeRemaining?: number;
};

export async function readDisks(timeoutMs = 6_000): Promise<{
  physical: DiskInfo[];
  volumes: VolumeInfo[];
}> {
  if (process.platform !== "win32") return { physical: [], volumes: [] };
  const [pd, vol] = await Promise.all([
    runPowerShellJson<RawDisk | RawDisk[]>(
      `Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, Size, BusType`,
      timeoutMs,
    ),
    runPowerShellJson<RawVol | RawVol[]>(
      `Get-Volume | Where-Object { $_.DriveType -eq 'Fixed' -or $_.DriveType -eq 'Removable' } | Select-Object DriveLetter, FileSystem, FileSystemLabel, Size, SizeRemaining`,
      timeoutMs,
    ),
  ]);

  const physical: DiskInfo[] = [];
  if (pd.ok) {
    const list = Array.isArray(pd.data) ? pd.data : pd.data === null ? [] : [pd.data];
    for (const d of list) {
      physical.push({
        model: d.FriendlyName ?? "unknown",
        mediaType: d.MediaType ?? "unknown",
        health: d.HealthStatus ?? "unknown",
        sizeGB:
          typeof d.Size === "number" ? Math.round(d.Size / (1024 ** 3)) : 0,
        busType: d.BusType ?? null,
      });
    }
  }
  const volumes: VolumeInfo[] = [];
  if (vol.ok) {
    const list = Array.isArray(vol.data) ? vol.data : vol.data === null ? [] : [vol.data];
    for (const v of list) {
      const size = typeof v.Size === "number" ? v.Size : 0;
      const free = typeof v.SizeRemaining === "number" ? v.SizeRemaining : 0;
      volumes.push({
        driveLetter: v.DriveLetter ?? null,
        fileSystem: v.FileSystem ?? "",
        label: v.FileSystemLabel ?? "",
        sizeGB: Math.round(size / (1024 ** 3)),
        freeGB: Math.round(free / (1024 ** 3)),
        freePct: size > 0 ? Math.round((free / size) * 1000) / 10 : 0,
      });
    }
  }
  return { physical, volumes };
}
