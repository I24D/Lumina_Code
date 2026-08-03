import { describe, expect, it } from "vitest";
import { createPerceptionBus } from "./perception-process.js";

describe("PerceptionBus", () => {
  it("fans out events to all subscribers and keeps a ring buffer", () => {
    const bus = createPerceptionBus(5);
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.on((e) => a.push(e.kind));
    const offB = bus.on((e) => b.push(e.kind));

    bus.emit({ kind: "start", atISO: "t", fps: 2, monitor: 1, threshold: 0.01 });
    bus.emit({ kind: "frame", atISO: "t", seq: 1, changedRatio: 0.1, path: "" });
    bus.emit({ kind: "foreground", atISO: "t", process: "chrome.exe", title: "X", pid: 1 });

    expect(a).toEqual(["start", "frame", "foreground"]);
    expect(b).toEqual(["start", "frame", "foreground"]);
    expect(bus.recent().map((e) => e.kind)).toEqual(["start", "frame", "foreground"]);

    offA();
    bus.emit({ kind: "heartbeat", atISO: "t", quietForSec: 30 });
    expect(a).toEqual(["start", "frame", "foreground"]); // a unsubscribed
    expect(b).toEqual(["start", "frame", "foreground", "heartbeat"]);
    offB();
  });

  it("respects ring capacity (drops oldest)", () => {
    const bus = createPerceptionBus(3);
    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "frame", atISO: "t", seq: i, changedRatio: 0.1, path: "" });
    }
    const recent = bus.recent();
    expect(recent.length).toBe(3);
    expect((recent[0] as { seq: number }).seq).toBe(2);
    expect((recent[2] as { seq: number }).seq).toBe(4);
  });

  it("recent(limit) caps to the requested number", () => {
    const bus = createPerceptionBus(10);
    for (let i = 0; i < 8; i++) {
      bus.emit({ kind: "frame", atISO: "t", seq: i, changedRatio: 0.1, path: "" });
    }
    expect(bus.recent(3).length).toBe(3);
  });
});
