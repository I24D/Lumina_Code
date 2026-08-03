/**
 * Tests for lumina_pc_observe / _scroll / _drag.
 *
 * Same pattern as smart-click.test.ts: mock the python sidecar, inject
 * a fake fetch into deps. No Bridge / no Python.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/python.js", () => ({
  runPythonSidecarJson: vi.fn(),
}));

import { runPythonSidecarJson } from "../shared/python.js";
import {
  createPcObserveTool,
  createPcScrollTool,
  createPcDragTool,
  type PcToolsDeps,
} from "./pc-tools.js";

const mockedSidecar = vi.mocked(runPythonSidecarJson);

type FetchCall = { url: string; body: unknown };

function makeDeps(): {
  deps: PcToolsDeps;
  calls: FetchCall[];
  setResponses: (r: Array<{ ok?: boolean; json?: () => Promise<unknown> }>) => void;
} {
  const calls: FetchCall[] = [];
  let queue: Array<{ ok?: boolean; json?: () => Promise<unknown> }> = [];
  const fakeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ url, body });
    const next = queue.shift();
    return {
      ok: next?.ok ?? true,
      status: 200,
      json: next?.json ?? (async () => ({ ok: true })),
    } as Response;
  });
  return {
    deps: {
      bridgeUrl: "http://127.0.0.1:8765",
      allowedApps: ["chrome.exe", "spotify.exe"],
      fetchImpl: fakeFetch as unknown as typeof fetch,
    },
    calls,
    setResponses: (r) => {
      queue = [...r];
    },
  };
}

const FAKE_ID = "tc_test";

beforeEach(() => {
  mockedSidecar.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── lumina_pc_observe ─────────────────────────────────────────────────

describe("lumina_pc_observe", () => {
  it("returns screenshot + foreground + interactables + windows in one call", async () => {
    const { deps, calls, setResponses } = makeDeps();
    setResponses([
      { json: async () => ({ ok: true, path: "C:/tmp/shot.png" }) },              // /screenshot
      {
        json: async () => ({
          ok: true,
          windows: [
            { title: "YouTube - Chrome", pid: 1234, process: "chrome.exe" },
            { title: "Spotify", pid: 5678, process: "spotify.exe" },
            { title: "", pid: 0, process: "" }, // empty title filtered out
          ],
        }),
      }, // /window_control list
    ]);
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        process: { pid: 1234, name: "chrome.exe", className: "Chrome_WidgetWin_1" },
        nodes: [
          { name: "Play", controlType: "Button", bbox: { x: 100, y: 100, w: 50, h: 50 }, center: { x: 125, y: 125 }, enabled: true, offscreen: false },
          { name: "Hidden", controlType: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 }, center: { x: 5, y: 5 }, enabled: true, offscreen: true }, // filtered (offscreen)
          { name: "Disabled", controlType: "Button", bbox: { x: 5, y: 5, w: 5, h: 5 }, center: { x: 7, y: 7 }, enabled: false, offscreen: false }, // filtered (disabled)
        ],
      },
    });
    const tool = createPcObserveTool(deps);
    const res = await tool.execute(FAKE_ID, {});
    const parsed = res.details as Record<string, any>;

    expect(parsed.screenshotPath).toBe("C:/tmp/shot.png");
    expect(parsed.foreground.name).toBe("chrome.exe");
    expect(parsed.interactableCount).toBe(1);
    expect(parsed.interactables[0].name).toBe("Play");
    expect(parsed.windowCount).toBe(2);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8765/screenshot",
      "http://127.0.0.1:8765/window_control",
    ]);
  });

  it("skips screenshot when includeScreenshot=false", async () => {
    const { deps, calls } = makeDeps();
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: { ok: true, process: { pid: 1, name: "notepad.exe", className: "" }, nodes: [] },
    });
    const tool = createPcObserveTool(deps);
    const res = await tool.execute(FAKE_ID, { includeScreenshot: false, includeWindows: false });
    const parsed = res.details as Record<string, any>;
    expect(parsed.screenshotPath).toBeNull();
    expect(parsed.windowCount).toBe(0);
    // Only fetch calls should be 0 (no screenshot, no window_control).
    expect(calls.length).toBe(0);
  });
});

// ── lumina_pc_scroll ──────────────────────────────────────────────────

describe("lumina_pc_scroll", () => {
  it("scrolls down 3 notches at current cursor (no query)", async () => {
    const { deps, calls, setResponses } = makeDeps();
    setResponses([
      { json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) },
    ]);
    const tool = createPcScrollTool(deps);
    const res = await tool.execute(FAKE_ID, {});
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(true);
    expect(parsed.direction).toBe("down");
    expect(parsed.notchDelta).toEqual({ dx: 0, dy: -360 }); // 3 * 120, negative for down
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8765/input_control");
    const body = calls[0]!.body as Record<string, any>;
    expect(body.action).toBe("mouse_scroll");
    expect(body.dy).toBe(-360);
    expect(body.x).toBeUndefined();
  });

  it("scrolls up at a UIA-resolved target", async () => {
    const { deps, calls, setResponses } = makeDeps();
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        process: { pid: 1, name: "chrome.exe", className: "" },
        matches: [{ name: "Playlist", score: 0.9, center: { x: 500, y: 400 }, controlType: "List", className: "", automationId: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, enabled: true, offscreen: false }],
      },
    });
    setResponses([{ json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) }]);
    const tool = createPcScrollTool(deps);
    const res = await tool.execute(FAKE_ID, { direction: "up", amount: 5, query: "Playlist" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(true);
    expect(parsed.notchDelta.dy).toBe(600); // 5 * 120, positive for up
    expect(parsed.hoverPoint).toEqual({ x: 500, y: 400 });
    const body = calls[0]!.body as Record<string, any>;
    expect(body.x).toBe(500);
    expect(body.y).toBe(400);
  });

  it("aborts when processName doesn't match", async () => {
    const { deps, calls } = makeDeps();
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        process: { pid: 1, name: "notepad.exe", className: "" },
        matches: [{ name: "Playlist", score: 0.9, center: { x: 1, y: 1 }, controlType: "List", className: "", automationId: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, enabled: true, offscreen: false }],
      },
    });
    const tool = createPcScrollTool(deps);
    const res = await tool.execute(FAKE_ID, { query: "Playlist", processName: "chrome.exe" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("process_mismatch");
    expect(calls.length).toBe(0);
  });
});

// ── lumina_pc_drag ────────────────────────────────────────────────────

describe("lumina_pc_drag", () => {
  it("drags between two coord points", async () => {
    const { deps, calls, setResponses } = makeDeps();
    setResponses([{ json: async () => ({ ok: true, allowed: true, processName: "explorer.exe" }) }]);
    const tool = createPcDragTool(deps);
    const res = await tool.execute(FAKE_ID, { fromX: 100, fromY: 200, toX: 300, toY: 400 });
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(true);
    expect(parsed.from).toEqual({ x: 100, y: 200 });
    expect(parsed.to).toEqual({ x: 300, y: 400 });
    const body = calls[0]!.body as Record<string, any>;
    expect(body.action).toBe("mouse_drag");
    expect(body.x1).toBe(100);
    expect(body.x2).toBe(300);
    expect(body.button).toBe("left");
  });

  it("drags between two UIA-resolved targets", async () => {
    const { deps, calls, setResponses } = makeDeps();
    // First resolve: from
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        process: { pid: 1, name: "chrome.exe", className: "" },
        matches: [{ name: "Task A", score: 0.9, center: { x: 200, y: 300 }, controlType: "Item", className: "", automationId: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, enabled: true, offscreen: false }],
      },
    });
    // Second resolve: to
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        process: { pid: 1, name: "chrome.exe", className: "" },
        matches: [{ name: "Done column", score: 0.85, center: { x: 800, y: 350 }, controlType: "Group", className: "", automationId: "", bbox: { x: 0, y: 0, w: 0, h: 0 }, enabled: true, offscreen: false }],
      },
    });
    setResponses([{ json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) }]);
    const tool = createPcDragTool(deps);
    const res = await tool.execute(FAKE_ID, { fromQuery: "Task A", toQuery: "Done column" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(true);
    expect(parsed.fromPicked.name).toBe("Task A");
    expect(parsed.toPicked.name).toBe("Done column");
    const body = calls[0]!.body as Record<string, any>;
    expect(body.x1).toBe(200);
    expect(body.x2).toBe(800);
  });

  it("returns error if fromQuery cannot be resolved", async () => {
    const { deps, calls } = makeDeps();
    mockedSidecar.mockResolvedValueOnce({
      ok: true,
      data: { ok: true, process: { pid: 1, name: "x", className: "" }, matches: [] },
    });
    const tool = createPcDragTool(deps);
    const res = await tool.execute(FAKE_ID, { fromQuery: "missing", toX: 100, toY: 100 });
    const parsed = res.details as Record<string, any>;
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/^from:/);
    expect(calls.length).toBe(0);
  });
});
