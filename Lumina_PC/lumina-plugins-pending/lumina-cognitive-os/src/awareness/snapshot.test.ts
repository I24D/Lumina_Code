/**
 * Tests for diffSnapshots (Nivel 1).
 */
import { describe, expect, it } from "vitest";
import { diffSnapshots, type EnvironmentSnapshot } from "./snapshot.js";

function baseSnap(): EnvironmentSnapshot {
  return {
    atISO: new Date().toISOString(),
    cpu: { usagePct: 30, cores: 8, loadAvg: [0, 0, 0] },
    memory: { totalMB: 16_000, freeMB: 8_000, usedPct: 50 },
    platform: { name: "win32", release: "10.0", hostname: "test", uptimeS: 100 },
    gpus: [],
    battery: { percent: 80, charging: false, status: "discharging", estimatedRuntimeMin: 120 },
    disks: { physical: [], volumes: [] },
    devices: [],
    monitors: [],
    network: { online: true, latencyMs: 12, profiles: [], adapters: [] },
  };
}

describe("diffSnapshots", () => {
  it("emits battery.low when crossing 20%", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.battery = { ...next.battery!, percent: 15 };
    const events = diffSnapshots(prev, next);
    expect(events.some((e) => e.kind === "battery.low")).toBe(true);
  });

  it("emits battery.critical when crossing 5%", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.battery = { ...next.battery!, percent: 3 };
    const events = diffSnapshots(prev, next);
    expect(events.some((e) => e.kind === "battery.critical")).toBe(true);
  });

  it("emits network.offline transition", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.network = { ...next.network, online: false, latencyMs: null };
    const events = diffSnapshots(prev, next);
    expect(events.some((e) => e.kind === "network.offline")).toBe(true);
  });

  it("emits cpu.high when crossing 90%", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.cpu = { ...next.cpu, usagePct: 95 };
    const events = diffSnapshots(prev, next);
    expect(events.some((e) => e.kind === "cpu.high")).toBe(true);
  });

  it("emits monitor.added when count grows", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.monitors = [
      { index: 0, primary: true, bounds: { x: 0, y: 0, w: 1920, h: 1080 }, workingArea: { x: 0, y: 0, w: 1920, h: 1040 }, deviceName: "A" },
    ];
    const events = diffSnapshots(prev, next);
    expect(events.some((e) => e.kind === "monitor.added")).toBe(true);
  });

  it("returns no events when nothing crosses thresholds", () => {
    const prev = baseSnap();
    const next = baseSnap();
    next.cpu = { ...next.cpu, usagePct: 31 };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(0);
  });
});
