/**
 * Tests for lumina_smart_click + lumina_smart_type.
 *
 * Strategy: mock the python sidecar via vi.mock and inject a fake
 * fetch into the deps so we don't touch Python or the Bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/python.js", () => {
  return {
    runPythonSidecarJson: vi.fn(),
  };
});

import { runPythonSidecarJson } from "../shared/python.js";
import { createSmartClickTool, createSmartTypeTool, type SmartClickDeps } from "./smart-click.js";

const mockedSidecar = vi.mocked(runPythonSidecarJson);

type FetchCall = { url: string; body: unknown };

function makeDeps(over: Partial<SmartClickDeps> = {}): { deps: SmartClickDeps; calls: FetchCall[]; setResponses: (r: Array<Partial<Response> & { json?: () => Promise<unknown> }>) => void } {
  const calls: FetchCall[] = [];
  let queue: Array<Partial<Response> & { json?: () => Promise<unknown> }> = [];
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
    if (!next) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    }
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: next.json ?? (async () => ({ ok: true })),
    } as Response;
  });
  const deps: SmartClickDeps = {
    bridgeUrl: "http://127.0.0.1:8765",
    allowedApps: ["chrome.exe"],
    fetchImpl: fakeFetch as unknown as typeof fetch,
    ...over,
  };
  return {
    deps,
    calls,
    setResponses: (r) => {
      queue = [...r];
    },
  };
}

const FAKE_TOOL_CALL_ID = "tc_test";

beforeEach(() => {
  mockedSidecar.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

function setUiaFind(matches: Array<Partial<{
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  center: { x: number; y: number } | null;
  enabled: boolean;
  offscreen: boolean;
  score: number;
}>>, process: { name: string; pid: number | null; className: string } | null = { name: "chrome.exe", pid: 1234, className: "Chrome_WidgetWin_1" }): void {
  mockedSidecar.mockResolvedValueOnce({
    ok: true,
    data: {
      ok: true,
      process,
      matches: matches.map((m) => ({
        name: m.name ?? "",
        automationId: m.automationId ?? "",
        controlType: m.controlType ?? "Button",
        className: m.className ?? "",
        bbox: m.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
        center: m.center ?? { x: 0, y: 0 },
        enabled: m.enabled ?? true,
        offscreen: m.offscreen ?? false,
        score: m.score ?? 0.9,
      })),
      nodesScanned: matches.length,
    },
  });
}

function setUiaTree(nodes: Array<{ name?: string; automationId?: string }> = []): void {
  mockedSidecar.mockResolvedValueOnce({
    ok: true,
    data: { ok: true, nodes },
  });
}

function payload<T = unknown>(call: FetchCall): T {
  return call.body as T;
}

describe("lumina_smart_click", () => {
  it("resolves UIA, dispatches click, verifies via screenshot_diff", async () => {
    const { deps, calls, setResponses } = makeDeps();
    setUiaFind([
      { name: "Play", automationId: "play-btn", score: 0.92, center: { x: 200, y: 300 } },
    ]);
    setResponses([
      { json: async () => ({ ok: true, path: "C:/tmp/pre.png" }) },        // pre screenshot
      { json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) }, // click
      { json: async () => ({ ok: true, path: "C:/tmp/post.png" }) },       // post screenshot
    ]);
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play" });
    const parsed = res.details as Record<string, any>;

    expect(parsed.dispatched).toBe(true);
    expect(parsed.strategy).toBe("uia");
    expect(parsed.picked.automationId).toBe("play-btn");
    expect(parsed.verification.policy).toBe("screenshot_diff");
    expect(calls.length).toBe(3);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8765/screenshot");
    expect(calls[1]!.url).toBe("http://127.0.0.1:8765/input_control");
    const clickPayload = payload<{ action: string; x: number; y: number; allowedApps: string[] }>(calls[1]!);
    expect(clickPayload.action).toBe("mouse_click");
    expect(clickPayload.x).toBe(200);
    expect(clickPayload.y).toBe(300);
    expect(clickPayload.allowedApps).toEqual(["chrome.exe"]);
  });

  it("returns no_confident_match when top score < minScore", async () => {
    const { deps } = makeDeps();
    setUiaFind([{ name: "Maybe Play", score: 0.3, center: { x: 1, y: 1 } }]);
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(false);
    expect(parsed.error).toBe("no_confident_match");
    expect(parsed.alternatives.length).toBe(1);
  });

  it("recommends vision fallback when allowVision=true and no UIA match", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind([]);
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play", allowVision: true });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(false);
    expect(parsed.visionFallbackRecommended).toBe(true);
    // We should NOT have called the bridge at all in this branch.
    expect(calls.length).toBe(0);
  });

  it("dryRun does not dispatch", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind([{ name: "Play", automationId: "play", score: 0.9, center: { x: 10, y: 10 } }]);
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play", dryRun: true });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(false);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.picked.automationId).toBe("play");
    expect(calls.length).toBe(0);
  });

  it("aborts when processName hint doesn't match foreground process", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind(
      [{ name: "Play", score: 0.95, center: { x: 10, y: 10 } }],
      { name: "notepad.exe", pid: 99, className: "Notepad" },
    );
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play", processName: "chrome.exe" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(false);
    expect(parsed.error).toBe("process_mismatch");
    expect(parsed.actualProcess).toBe("notepad.exe");
    expect(calls.length).toBe(0); // no bridge call when process doesn't match
  });

  it("verify='uia' uses uia_recheck and does NOT take screenshots", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind([{ name: "Play", automationId: "play", score: 0.95, center: { x: 10, y: 10 } }]);
    setUiaTree([{ name: "Pause", automationId: "pause" }]); // play no longer present
    const tool = createSmartClickTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Play", verify: "uia" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(true);
    expect(parsed.verification.policy).toBe("uia_recheck");
    // Only ONE bridge call (the click); no screenshot endpoints.
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8765/input_control");
  });
});

describe("lumina_smart_type", () => {
  it("clicks to focus then types into a resolved Edit field", async () => {
    const { deps, calls, setResponses } = makeDeps();
    setUiaFind(
      [{ name: "Search", controlType: "Edit", score: 0.88, center: { x: 400, y: 50 } }],
    );
    setResponses([
      { json: async () => ({ ok: true, path: "C:/tmp/pre.png" }) },        // pre screenshot
      { json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) }, // focus click
      { json: async () => ({ ok: true, allowed: true, processName: "chrome.exe" }) }, // type_text
      { json: async () => ({ ok: true, path: "C:/tmp/post.png" }) },       // post screenshot
    ]);
    const tool = createSmartTypeTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Search", text: "Lumina rocks" });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(true);
    expect(parsed.picked.controlType).toBe("Edit");
    expect(parsed.verification.policy).toBe("screenshot_diff");

    expect(calls.length).toBe(4);
    expect(calls[1]!.url).toBe("http://127.0.0.1:8765/input_control");
    const focus = payload<{ action: string }>(calls[1]!);
    expect(focus.action).toBe("mouse_click");
    const typeCall = payload<{ action: string; text: string }>(calls[2]!);
    expect(typeCall.action).toBe("type_text");
    expect(typeCall.text).toBe("Lumina rocks");
  });

  it("dryRun returns picked candidate without dispatching", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind([{ name: "Search", controlType: "Edit", score: 0.9, center: { x: 1, y: 1 } }]);
    const tool = createSmartTypeTool(deps);
    const res = await tool.execute(FAKE_TOOL_CALL_ID, { query: "Search", text: "hi", dryRun: true });
    const parsed = res.details as Record<string, any>;
    expect(parsed.dispatched).toBe(false);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.picked.name).toBe("Search");
    expect(calls.length).toBe(0);
  });

  it("optionally presses ENTER after typing", async () => {
    const { deps, calls } = makeDeps();
    setUiaFind([{ name: "Search", controlType: "Edit", score: 0.9, center: { x: 1, y: 1 } }]);
    const tool = createSmartTypeTool(deps);
    await tool.execute(FAKE_TOOL_CALL_ID, {
      query: "Search",
      text: "hi",
      pressEnter: true,
      verify: "none",
    });
    // With verify="none": no pre/post screenshots, no uia tree fetch.
    // Calls: focus click + type_text + ENTER key_press = 3 bridge calls.
    expect(calls.length).toBe(3);
    const enter = payload<{ action: string; keys: string[] }>(calls[2]!);
    expect(enter.action).toBe("key_press");
    expect(enter.keys).toEqual(["ENTER"]);
  });
});
