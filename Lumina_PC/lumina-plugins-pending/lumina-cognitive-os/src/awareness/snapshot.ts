/**
 * snapshot.ts — Unified EnvironmentSnapshot.
 *
 * Combines CPU/RAM (node:os) + GPU + battery + disks + devices + monitors +
 * network into a single serialisable object. The poller compares consecutive
 * snapshots and emits AwarenessChange events on the bus when something
 * crosses a threshold.
 */
import os from "node:os";
import { AwarenessEventBus, type AwarenessChange } from "./event-bus.js";
import { readBatteryInfo, type BatteryInfo } from "./battery.js";
import { readDevices, type DeviceInfo } from "./devices.js";
import { readDisks, type DiskInfo, type VolumeInfo } from "./disks.js";
import { readGpuInfo, type GpuInfo } from "./gpu.js";
import { readMonitors, type MonitorInfo } from "./monitors.js";
import { readNetwork, type NetworkInfo } from "./network.js";

export type EnvironmentSnapshot = {
  readonly atISO: string;
  readonly cpu: { readonly usagePct: number; readonly cores: number; readonly loadAvg: number[] };
  readonly memory: {
    readonly totalMB: number;
    readonly freeMB: number;
    readonly usedPct: number;
  };
  readonly platform: { readonly name: string; readonly release: string; readonly hostname: string; readonly uptimeS: number };
  readonly gpus: ReadonlyArray<GpuInfo>;
  readonly battery: BatteryInfo | null;
  readonly disks: { readonly physical: ReadonlyArray<DiskInfo>; readonly volumes: ReadonlyArray<VolumeInfo> };
  readonly devices: ReadonlyArray<DeviceInfo>;
  readonly monitors: ReadonlyArray<MonitorInfo>;
  readonly network: NetworkInfo;
};

function cpuUsagePct(sampleMs = 300): Promise<number> {
  return new Promise((resolve) => {
    const t0 = os.cpus().map((c) => ({ ...c.times }));
    setTimeout(() => {
      const t1 = os.cpus();
      let idle = 0;
      let total = 0;
      for (let i = 0; i < t1.length; i++) {
        const a = t0[i];
        const b = t1[i]?.times;
        if (!a || !b) continue;
        idle += b.idle - a.idle;
        total +=
          b.user + b.nice + b.sys + b.idle + b.irq -
          (a.user + a.nice + a.sys + a.idle + a.irq);
      }
      resolve(total === 0 ? 0 : Math.round((100 - (100 * idle) / total) * 10) / 10);
    }, sampleMs);
  });
}

export async function readEnvironmentSnapshot(): Promise<EnvironmentSnapshot> {
  const [cpuPct, gpus, battery, disks, devices, monitors, network] = await Promise.all([
    cpuUsagePct(),
    readGpuInfo(),
    readBatteryInfo(),
    readDisks(),
    readDevices(),
    readMonitors(),
    readNetwork(),
  ]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    atISO: new Date().toISOString(),
    cpu: {
      usagePct: cpuPct,
      cores: os.cpus().length,
      loadAvg: os.loadavg(),
    },
    memory: {
      totalMB: Math.round(totalMem / (1024 * 1024)),
      freeMB: Math.round(freeMem / (1024 * 1024)),
      usedPct: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
    },
    platform: {
      name: os.platform(),
      release: os.release(),
      hostname: os.hostname(),
      uptimeS: Math.floor(os.uptime()),
    },
    gpus,
    battery,
    disks,
    devices,
    monitors,
    network,
  };
}

// ── Diff + emit ───────────────────────────────────────────────────────

function deviceKey(d: DeviceInfo): string {
  return `${d.class}::${d.name}`;
}

export function diffSnapshots(
  prev: EnvironmentSnapshot | null,
  next: EnvironmentSnapshot,
): AwarenessChange[] {
  const events: AwarenessChange[] = [];
  // Battery
  if (next.battery) {
    if (next.battery.percent <= 5 && (prev?.battery?.percent ?? 100) > 5) {
      events.push({ kind: "battery.critical", percent: next.battery.percent });
    } else if (next.battery.percent <= 20 && (prev?.battery?.percent ?? 100) > 20) {
      events.push({ kind: "battery.low", percent: next.battery.percent });
    }
    if (
      prev?.battery &&
      prev.battery.charging !== next.battery.charging
    ) {
      events.push({ kind: "battery.charging.changed", charging: next.battery.charging });
    }
  }
  // Network
  if (prev && prev.network.online && !next.network.online) {
    events.push({ kind: "network.offline" });
  } else if (prev && !prev.network.online && next.network.online) {
    events.push({ kind: "network.online", latencyMs: next.network.latencyMs ?? -1 });
  }
  // Monitors
  if (prev) {
    if (next.monitors.length > prev.monitors.length) {
      for (let i = prev.monitors.length; i < next.monitors.length; i++) {
        events.push({ kind: "monitor.added", index: i });
      }
    } else if (next.monitors.length < prev.monitors.length) {
      for (let i = next.monitors.length; i < prev.monitors.length; i++) {
        events.push({ kind: "monitor.removed", index: i });
      }
    }
  }
  // Disks
  for (const v of next.disks.volumes) {
    if (v.freePct <= 5 && v.driveLetter) {
      const prevV = prev?.disks.volumes.find((p) => p.driveLetter === v.driveLetter);
      if (!prevV || prevV.freePct > 5) {
        events.push({ kind: "disk.low", drive: v.driveLetter, freePct: v.freePct });
      }
    }
  }
  // CPU / RAM
  if (next.cpu.usagePct >= 90 && (prev?.cpu.usagePct ?? 0) < 90) {
    events.push({ kind: "cpu.high", pct: next.cpu.usagePct });
  }
  if (next.memory.usedPct >= 90 && (prev?.memory.usedPct ?? 0) < 90) {
    events.push({ kind: "ram.high", pct: next.memory.usedPct });
  }
  // GPU count
  if (prev && prev.gpus.length !== next.gpus.length) {
    events.push({ kind: "gpu.changed", count: next.gpus.length });
  }
  // Devices add/remove
  if (prev) {
    const prevKeys = new Set(prev.devices.map(deviceKey));
    const nextKeys = new Set(next.devices.map(deviceKey));
    for (const d of next.devices) {
      if (!prevKeys.has(deviceKey(d))) {
        events.push({ kind: "device.added", className: d.class, name: d.name });
      }
    }
    for (const d of prev.devices) {
      if (!nextKeys.has(deviceKey(d))) {
        events.push({ kind: "device.removed", className: d.class, name: d.name });
      }
    }
  }
  return events;
}

export class AwarenessPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: EnvironmentSnapshot | null = null;
  private inFlight = false;

  constructor(
    private readonly intervalMs: number,
    private readonly bus: AwarenessEventBus,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  current(): EnvironmentSnapshot | null {
    return this.last;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const snap = await readEnvironmentSnapshot();
      const events = diffSnapshots(this.last, snap);
      this.last = snap;
      for (const ev of events) this.bus.emit(ev);
    } catch {
      // Never throw — this poller runs forever and must survive errors.
    } finally {
      this.inFlight = false;
    }
  }
}
