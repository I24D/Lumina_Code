/**
 * Tests for the operative daemon — rule matching, debounce, dispatcher.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import { ActionLogStore } from "../memory/action-log.js";
import {
  loadOperativeRules,
  renderSuggestion,
  ruleMatches,
} from "./operative-rules.js";
import { OperativeDaemon, type ToastDispatcher } from "./operative-daemon.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-op-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeRules(rules: unknown[]): string {
  const p = path.join(tmpDir, "operative-rules.json");
  fs.writeFileSync(p, JSON.stringify(rules), "utf8");
  return p;
}

describe("loadOperativeRules — validation", () => {
  it("loads a valid rule", () => {
    const rulesPath = writeRules([
      {
        id: "battery-low",
        trigger: { kind: "battery.low" },
        suggestion: { title: "Low", message: "{percent}%" },
      },
    ]);
    const set = loadOperativeRules(rulesPath);
    expect(set.rules.length).toBe(1);
    expect(set.errors.length).toBe(0);
    expect(set.rules[0]!.debounceSeconds).toBe(300);
    expect(set.rules[0]!.enabled).toBe(true);
  });

  it("rejects rule without id", () => {
    const rulesPath = writeRules([{ trigger: { kind: "battery.low" }, suggestion: { title: "T", message: "M" } }]);
    const set = loadOperativeRules(rulesPath);
    expect(set.rules.length).toBe(0);
    expect(set.errors[0]!.error).toMatch(/id/);
  });

  it("rejects unknown event kind", () => {
    const rulesPath = writeRules([
      { id: "x", trigger: { kind: "lol.unknown" }, suggestion: { title: "T", message: "M" } },
    ]);
    const set = loadOperativeRules(rulesPath);
    expect(set.errors[0]!.error).toMatch(/unknown trigger.kind/);
  });

  it("rejects missing title or message", () => {
    const rulesPath = writeRules([
      { id: "a", trigger: { kind: "cpu.high" }, suggestion: { title: "" } },
    ]);
    const set = loadOperativeRules(rulesPath);
    expect(set.errors[0]!.error).toMatch(/title/);
  });

  it("returns empty list when file does not exist", () => {
    const set = loadOperativeRules(path.join(tmpDir, "missing.json"));
    expect(set.rules).toEqual([]);
    expect(set.errors).toEqual([]);
  });

  it("captures parse errors instead of throwing", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "{ not json", "utf8");
    const set = loadOperativeRules(p);
    expect(set.errors.length).toBe(1);
    expect(set.errors[0]!.error).toMatch(/invalid JSON/);
  });
});

describe("ruleMatches — conditions", () => {
  it("matches battery.low when percent ≤ maxPercent", () => {
    const set = loadOperativeRules(
      writeRules([
        {
          id: "bl",
          trigger: { kind: "battery.low" },
          condition: { maxPercent: 20 },
          suggestion: { title: "T", message: "M" },
        },
      ]),
    );
    expect(ruleMatches(set.rules[0]!, { kind: "battery.low", percent: 15 })).toBe(true);
    expect(ruleMatches(set.rules[0]!, { kind: "battery.low", percent: 25 })).toBe(false);
  });

  it("matches disk.low when drive matches", () => {
    const set = loadOperativeRules(
      writeRules([
        {
          id: "dl",
          trigger: { kind: "disk.low" },
          condition: { drive: "C:", maxFreePct: 5 },
          suggestion: { title: "T", message: "M" },
        },
      ]),
    );
    expect(ruleMatches(set.rules[0]!, { kind: "disk.low", drive: "C:", freePct: 3 })).toBe(true);
    expect(ruleMatches(set.rules[0]!, { kind: "disk.low", drive: "D:", freePct: 3 })).toBe(false);
    expect(ruleMatches(set.rules[0]!, { kind: "disk.low", drive: "C:", freePct: 10 })).toBe(false);
  });

  it("respects enabled=false", () => {
    const set = loadOperativeRules(
      writeRules([
        {
          id: "off",
          enabled: false,
          trigger: { kind: "battery.low" },
          suggestion: { title: "T", message: "M" },
        },
      ]),
    );
    expect(ruleMatches(set.rules[0]!, { kind: "battery.low", percent: 5 })).toBe(false);
  });
});

describe("renderSuggestion — templating", () => {
  it("substitutes {percent}", () => {
    const set = loadOperativeRules(
      writeRules([
        {
          id: "bl",
          trigger: { kind: "battery.low" },
          suggestion: { title: "Bateria al {percent}%", message: "Estas al {percent}%" },
        },
      ]),
    );
    const s = renderSuggestion(set.rules[0]!, { kind: "battery.low", percent: 12 });
    expect(s.title).toBe("Bateria al 12%");
    expect(s.message).toBe("Estas al 12%");
  });

  it("leaves unknown placeholders untouched", () => {
    const set = loadOperativeRules(
      writeRules([
        { id: "x", trigger: { kind: "cpu.high" }, suggestion: { title: "CPU {pct}% on {host}", message: "ok" } },
      ]),
    );
    const s = renderSuggestion(set.rules[0]!, { kind: "cpu.high", pct: 95 });
    expect(s.title).toBe("CPU 95% on {host}");
  });
});

describe("OperativeDaemon — end to end", () => {
  it("dispatches a toast on matching event and respects debounce", async () => {
    const rulesPath = writeRules([
      {
        id: "bl",
        trigger: { kind: "battery.low" },
        condition: { maxPercent: 20 },
        debounceSeconds: 60,
        suggestion: { title: "Bat {percent}%", message: "msg" },
      },
    ]);
    const bus = new AwarenessEventBus();
    const log = new ActionLogStore(tmpDir);
    const dispatcher = vi.fn<Parameters<ToastDispatcher>, ReturnType<ToastDispatcher>>();
    const daemon = new OperativeDaemon({
      bus,
      log,
      rulesPath,
      toastDispatcher: dispatcher,
      autoStart: true,
    });
    bus.emit({ kind: "battery.low", percent: 15 });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0]![0]!.title).toBe("Bat 15%");

    // Second emit within debounce window → no dispatch.
    bus.emit({ kind: "battery.low", percent: 14 });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher).toHaveBeenCalledTimes(1);

    daemon.stop();
  });

  it("does not fire when condition fails", async () => {
    const rulesPath = writeRules([
      {
        id: "bl",
        trigger: { kind: "battery.low" },
        condition: { maxPercent: 10 },
        suggestion: { title: "t", message: "m" },
      },
    ]);
    const bus = new AwarenessEventBus();
    const dispatcher = vi.fn();
    const daemon = new OperativeDaemon({
      bus,
      log: null,
      rulesPath,
      toastDispatcher: dispatcher,
    });
    bus.emit({ kind: "battery.low", percent: 19 });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher).not.toHaveBeenCalled();
    daemon.stop();
  });

  it("stop() halts dispatches; start() resumes", async () => {
    const rulesPath = writeRules([
      { id: "off", trigger: { kind: "network.offline" }, suggestion: { title: "t", message: "m" } },
    ]);
    const bus = new AwarenessEventBus();
    const dispatcher = vi.fn();
    const daemon = new OperativeDaemon({
      bus,
      log: null,
      rulesPath,
      toastDispatcher: dispatcher,
    });
    daemon.stop();
    bus.emit({ kind: "network.offline" });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher).not.toHaveBeenCalled();
    daemon.start();
    bus.emit({ kind: "network.offline" });
    await new Promise((r) => setImmediate(r));
    expect(dispatcher).toHaveBeenCalledTimes(1);
    daemon.stop();
  });

  it("reload() picks up edits to the rules file", async () => {
    const rulesPath = writeRules([
      { id: "a", trigger: { kind: "cpu.high" }, suggestion: { title: "t", message: "m" } },
    ]);
    const bus = new AwarenessEventBus();
    const dispatcher = vi.fn();
    const daemon = new OperativeDaemon({ bus, log: null, rulesPath, toastDispatcher: dispatcher });
    expect(daemon.status().enabledCount).toBe(1);
    writeRules([
      { id: "a", trigger: { kind: "cpu.high" }, suggestion: { title: "t", message: "m" } },
      { id: "b", trigger: { kind: "ram.high" }, suggestion: { title: "t", message: "m" } },
    ]);
    daemon.reload();
    expect(daemon.status().enabledCount).toBe(2);
    daemon.stop();
  });

  it("status() reports load errors without crashing", () => {
    const rulesPath = writeRules([
      { id: "ok", trigger: { kind: "cpu.high" }, suggestion: { title: "t", message: "m" } },
      { id: "bad", trigger: { kind: "totally.bogus" }, suggestion: { title: "t", message: "m" } },
    ]);
    const bus = new AwarenessEventBus();
    const daemon = new OperativeDaemon({ bus, log: null, rulesPath, toastDispatcher: vi.fn() });
    expect(daemon.status().errorCount).toBe(1);
    expect(daemon.status().enabledCount).toBe(1);
    daemon.stop();
  });
});
