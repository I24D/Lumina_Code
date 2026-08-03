/**
 * Tests for the Replay engine.
 *
 * We mock the LiveContextProvider and ActionDispatcher so the tests are
 * pure — no Bridge, no real subprocess. Strategies are exercised through
 * the real engine to cover the integration glue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderStore, type RecordingEvent } from "../recorder/recorder-store.js";
import { ReplayEngine, type ActionDispatcher, type LiveContextProvider } from "./replay-engine.js";
import { ALL_STRATEGY_IDS, type ResolvedAction } from "./strategies/types.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-replay-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seed(store: RecorderStore, sessionId: string, events: RecordingEvent[]): void {
  const dir = store.prepareNewSessionDir(sessionId);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      sessionId,
      version: "test",
      mode: "events",
      captureUia: true,
      fpsHintHz: 5,
      startedAtISO: "2026-06-28T09:00:00.000Z",
      stoppedAtISO: "2026-06-28T09:00:05.000Z",
      eventCount: events.length,
      platform: "win32",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

function liveProvider(over: Partial<Awaited<ReturnType<LiveContextProvider>>> = {}): LiveContextProvider {
  return async () => ({
    screenshotPath: null,
    uiaNodes: null,
    windows: [],
    ...over,
  });
}

const noopDispatcher: ActionDispatcher = vi.fn(async () => ({ ok: true }));

describe("ReplayEngine — basic lifecycle", () => {
  it("runs a recording in simulate mode without dispatching", async () => {
    const store = new RecorderStore(tmpDir);
    seed(store, "s1", [
      { idx: 1, atMs: 0, kind: "session.start" },
      { idx: 2, atMs: 100, kind: "mouse.down", pos: { x: 50, y: 60 }, button: "left" },
      { idx: 3, atMs: 200, kind: "mouse.up", pos: { x: 50, y: 60 }, button: "left" },
      { idx: 4, atMs: 300, kind: "key.down", key: "a" },
      { idx: 5, atMs: 400, kind: "key.up", key: "a" },
    ]);
    const dispatcher = vi.fn<Parameters<ActionDispatcher>, ReturnType<ActionDispatcher>>(async () => ({ ok: true }));
    const engine = new ReplayEngine({
      store,
      log: null,
      liveContextProvider: liveProvider(),
      actionDispatcher: dispatcher,
    });
    const run = await engine.run({ sessionId: "s1", strategyId: "naive_coords", mode: "simulate", interStepDelayMs: 0 });
    expect(run.status).toBe("done");
    expect(run.steps.length).toBe(5);
    expect(dispatcher).not.toHaveBeenCalled(); // simulate mode
    const click = run.steps[1]!;
    expect(click.resolved.kind).toBe("mouse_click");
    if (click.resolved.kind === "mouse_click") expect(click.resolved.x).toBe(50);
  });

  it("dispatches in production mode", async () => {
    const store = new RecorderStore(tmpDir);
    seed(store, "s2", [
      { idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 5, y: 10 }, button: "left" },
    ]);
    const dispatcher = vi.fn<Parameters<ActionDispatcher>, ReturnType<ActionDispatcher>>(async () => ({ ok: true }));
    const engine = new ReplayEngine({
      store,
      log: null,
      liveContextProvider: liveProvider(),
      actionDispatcher: dispatcher,
    });
    await engine.run({ sessionId: "s2", strategyId: "naive_coords", mode: "production", interStepDelayMs: 0, verifyEachStep: false });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const action = dispatcher.mock.calls[0]![0]! as ResolvedAction;
    expect(action.kind).toBe("mouse_click");
  });

  it("aborts mid-run when abort() is called between steps", async () => {
    const store = new RecorderStore(tmpDir);
    seed(store, "abort", Array.from({ length: 5 }, (_, i) => ({
      idx: i + 1,
      atMs: i * 100,
      kind: "mouse.down",
      pos: { x: i, y: i },
      button: "left",
    })));
    const engine = new ReplayEngine({
      store,
      log: null,
      liveContextProvider: liveProvider(),
      actionDispatcher: noopDispatcher,
    });
    // Manually create the run via the engine — we abort right after first step by hijacking onStep.
    const run = await engine.run({
      sessionId: "abort",
      strategyId: "naive_coords",
      mode: "simulate",
      interStepDelayMs: 0,
      onStep: (_s, r) => {
        if (r.steps.length === 1) engine.abort(r.id);
      },
    });
    expect(run.status).toBe("aborted");
    expect(run.steps.length).toBe(1);
  });

  it("returns error for unknown strategy", async () => {
    const store = new RecorderStore(tmpDir);
    seed(store, "s3", [{ idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 1, y: 2 }, button: "left" }]);
    const engine = new ReplayEngine({
      store,
      log: null,
      liveContextProvider: liveProvider(),
      actionDispatcher: noopDispatcher,
    });
    await expect(
      engine.run({ sessionId: "s3", strategyId: "bogus" as never, mode: "simulate" }),
    ).rejects.toThrow(/unknown strategy/);
  });

  it("returns error for missing session", async () => {
    const store = new RecorderStore(tmpDir);
    const engine = new ReplayEngine({
      store,
      log: null,
      liveContextProvider: liveProvider(),
      actionDispatcher: noopDispatcher,
    });
    await expect(
      engine.run({ sessionId: "missing", mode: "simulate" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("strategies — registry shape", () => {
  it("exposes all 5 declared strategies", async () => {
    const { STRATEGIES, getStrategy } = await import("./strategies/registry.js");
    for (const id of ALL_STRATEGY_IDS) {
      expect(STRATEGIES[id]).toBeTruthy();
      expect(getStrategy(id)).toBeTruthy();
    }
    expect(getStrategy("nope")).toBeNull();
  });
});

describe("naive_coords — event mapping", () => {
  it("maps non-actionable events to skip", async () => {
    const { naiveCoordsStrategy } = await import("./strategies/naive-coords.js");
    const ctx = {
      recorded: { idx: 1, atMs: 0, kind: "session.start" },
      live: { screenshotPath: null, uiaNodes: null, windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await naiveCoordsStrategy.resolve(ctx as any);
    expect(r.kind).toBe("skip");
  });

  it("emits a click on mouse.down with the right coords", async () => {
    const { naiveCoordsStrategy } = await import("./strategies/naive-coords.js");
    const ctx = {
      recorded: { idx: 2, atMs: 0, kind: "mouse.down", pos: { x: 100, y: 200 }, button: "left" },
      live: { screenshotPath: null, uiaNodes: null, windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await naiveCoordsStrategy.resolve(ctx as any);
    expect(r.kind).toBe("mouse_click");
    if (r.kind === "mouse_click") {
      expect(r.x).toBe(100);
      expect(r.y).toBe(200);
      expect(r.button).toBe("left");
    }
  });

  it("treats single-char key.down as type_text", async () => {
    const { naiveCoordsStrategy } = await import("./strategies/naive-coords.js");
    const ctx = {
      recorded: { idx: 3, atMs: 0, kind: "key.down", key: "h" },
      live: { screenshotPath: null, uiaNodes: null, windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await naiveCoordsStrategy.resolve(ctx as any);
    expect(r.kind).toBe("type_text");
    if (r.kind === "type_text") expect(r.text).toBe("h");
  });

  it("treats named key.down as key_press", async () => {
    const { naiveCoordsStrategy } = await import("./strategies/naive-coords.js");
    const ctx = {
      recorded: { idx: 4, atMs: 0, kind: "key.down", key: "enter" },
      live: { screenshotPath: null, uiaNodes: null, windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await naiveCoordsStrategy.resolve(ctx as any);
    expect(r.kind).toBe("key_press");
    if (r.kind === "key_press") expect(r.keys).toEqual(["enter"]);
  });
});

describe("uia_grounded — finds element by automationId", () => {
  it("clicks the matched element's center", async () => {
    const { uiaGroundedStrategy } = await import("./strategies/uia-grounded.js");
    const ctx = {
      recorded: {
        idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 800, y: 500 }, button: "left",
        // Engine would normally inject this via enrichEvent(); we set it manually.
        element: { automationId: "saveBtn", name: "Save" },
      },
      live: {
        screenshotPath: null,
        uiaNodes: [
          { automationId: "openBtn", name: "Open", bbox: { x: 10, y: 20, w: 60, h: 30 }, center: { x: 40, y: 35 } },
          { automationId: "saveBtn", name: "Save", bbox: { x: 700, y: 400, w: 100, h: 40 }, center: { x: 750, y: 420 } },
        ],
        windows: [],
      },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await uiaGroundedStrategy.resolve(ctx as any);
    expect(r.kind).toBe("mouse_click");
    if (r.kind === "mouse_click") {
      expect(r.x).toBe(750);
      expect(r.y).toBe(420);
      if (r.via.source === "uia_grounded") expect(r.via.automationId).toBe("saveBtn");
    }
  });

  it("skips when no recorded element is present", async () => {
    const { uiaGroundedStrategy } = await import("./strategies/uia-grounded.js");
    const ctx = {
      recorded: { idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 1, y: 2 }, button: "left" },
      live: { screenshotPath: null, uiaNodes: [], windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await uiaGroundedStrategy.resolve(ctx as any);
    expect(r.kind).toBe("skip");
  });
});

describe("vision_grounded — without OmniParser client", () => {
  it("skips when client not configured", async () => {
    const { visionGroundedStrategy, configureOmniParserClient } = await import("./strategies/vision-grounded.js");
    configureOmniParserClient(null);
    const ctx = {
      recorded: { idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 50, y: 50 }, button: "left" },
      live: {
        screenshotPath: "/tmp/x.png",
        uiaNodes: null,
        windows: [],
      },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await visionGroundedStrategy.resolve(ctx as any);
    expect(r.kind).toBe("skip");
  });

  it("uses a stub client to pick closest element", async () => {
    const { visionGroundedStrategy, configureOmniParserClient } = await import("./strategies/vision-grounded.js");
    configureOmniParserClient(async () => ({
      ok: true,
      elements: [
        { bbox: { x: 0, y: 0, w: 20, h: 20 }, center: { x: 10, y: 10 } },
        { bbox: { x: 40, y: 40, w: 20, h: 20 }, center: { x: 50, y: 50 }, label: "Target" },
        { bbox: { x: 500, y: 500, w: 20, h: 20 }, center: { x: 510, y: 510 } },
      ],
    }));
    const ctx = {
      recorded: { idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 55, y: 55 }, button: "left" },
      live: { screenshotPath: "/tmp/x.png", uiaNodes: null, windows: [] },
      recordingDir: tmpDir,
      dryRun: true,
    } as const;
    const r = await visionGroundedStrategy.resolve(ctx as any);
    expect(r.kind).toBe("mouse_click");
    if (r.kind === "mouse_click") {
      expect(r.x).toBe(50);
      expect(r.y).toBe(50);
    }
    configureOmniParserClient(null);
  });
});

describe("set-of-marks", () => {
  it("builds a numbered description from elements", async () => {
    const { buildSetOfMarks, resolveSetOfMarksChoice } = await import("../vision/set-of-marks.js");
    const elements = [
      { bbox: { x: 10, y: 10, w: 50, h: 20 }, center: { x: 35, y: 20 }, label: "First", kind: "icon" },
      { bbox: { x: 100, y: 100, w: 50, h: 20 }, center: { x: 125, y: 110 }, label: "Second", kind: "icon" },
    ];
    const marks = buildSetOfMarks(elements);
    expect(marks.count).toBe(2);
    expect(marks.description).toContain("1.");
    expect(marks.description).toContain("First");
    expect(marks.description).toContain("Second");

    const choice = resolveSetOfMarksChoice("I think 2 is the target", marks);
    expect(choice?.label).toBe("Second");
    expect(resolveSetOfMarksChoice("invalid", marks)).toBeNull();
  });
});
