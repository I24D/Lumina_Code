import { describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../shared/bridge-client.js";
import {
  createAppListTool,
  createAppLaunchTool,
  createAppCloseTool,
} from "./app-tools.js";

function fakeClient(handler: (path: string, body?: unknown) => unknown): {
  client: BridgeClient;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    client: {
      bridgeUrl: "http://127.0.0.1:8765",
      post: vi.fn(async (path: string, body?: unknown) => {
        calls.push({ path, body });
        return handler(path, body);
      }) as BridgeClient["post"],
      get: vi.fn(async () => ({ ok: true })) as BridgeClient["get"],
    },
  };
}

const ID = "tc";

describe("lumina_app_list", () => {
  it("calls /window_control discover and returns apps", async () => {
    const { client, calls } = fakeClient(() => ({
      ok: true,
      count: 2,
      apps: [
        { name: "Microsoft Excel", appId: "EXCEL.EXE" },
        { name: "Microsoft Word", appId: "WINWORD.EXE" },
      ],
    }));
    const tool = createAppListTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { filter: "microsoft" });
    const d = res.details as Record<string, any>;

    expect(d.ok).toBe(true);
    expect(d.count).toBe(2);
    expect(d.apps[0].name).toBe("Microsoft Excel");
    expect(calls[0]).toEqual({
      path: "/window_control",
      body: { action: "discover", filter: "microsoft", limit: 200 },
    });
  });

  it("surfaces bridge_unreachable cleanly", async () => {
    const { client } = fakeClient(() => null);
    const tool = createAppListTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, {});
    expect((res.details as Record<string, any>).ok).toBe(false);
    expect((res.details as Record<string, any>).error).toBe("bridge_unreachable");
  });
});

describe("lumina_app_launch", () => {
  it("launches a known alias via Bridge", async () => {
    const { client, calls } = fakeClient(() => ({
      ok: true,
      launched: true,
      application: "word",
      display_name: "Microsoft Word",
      via: "alias",
    }));
    const tool = createAppLaunchTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { application: "Word" });
    const d = res.details as Record<string, any>;

    expect(d.ok).toBe(true);
    expect(d.launched).toBe(true);
    expect(d.via).toBe("alias");
    expect(d.displayName).toBe("Microsoft Word");
    expect(calls[0]!.body).toMatchObject({ action: "launch", application: "word" });
  });

  it("surfaces fuzzy alternatives when there is no exact match", async () => {
    const { client } = fakeClient(() => ({
      ok: true,
      launched: true,
      via: "start_apps",
      picked: { name: "Krita", appId: "Krita.Krita_..." },
      alternativeCount: 2,
      alternatives: [
        { name: "Krita", appId: "Krita.Krita_..." },
        { name: "Krita Beta", appId: "Krita.Beta_..." },
      ],
    }));
    const tool = createAppLaunchTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { application: "krita" });
    const d = res.details as Record<string, any>;

    expect(d.launched).toBe(true);
    expect(d.via).toBe("start_apps");
    expect(d.alternativeCount).toBe(2);
    expect(d.picked.name).toBe("Krita");
  });

  it("hints when no_match comes back", async () => {
    const { client } = fakeClient(() => ({ ok: false, error: "no_match" }));
    const tool = createAppLaunchTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { application: "qwertyzxc" });
    const d = res.details as Record<string, any>;
    expect(d.ok).toBe(false);
    expect(d.error).toBe("no_match");
    expect(d.hint).toContain("lumina_app_list");
  });
});

describe("lumina_app_close", () => {
  it("closes by title (graceful WM_CLOSE)", async () => {
    const { client, calls } = fakeClient(() => ({ ok: true, closed: true, count: 1, killed: 1, force: false }));
    const tool = createAppCloseTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { title: "Notepad" });
    const d = res.details as Record<string, any>;

    expect(d.ok).toBe(true);
    expect(d.closed).toBe(true);
    expect(d.matchCount).toBe(1);
    expect(d.killed).toBe(1);
    expect(calls[0]!.body).toMatchObject({ action: "close", title: "Notepad", force: false });
  });

  it("closes by pid with force", async () => {
    const { client, calls } = fakeClient(() => ({ ok: true, closed: true, count: 1, killed: 1, force: true }));
    const tool = createAppCloseTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { pid: 1234, force: true });
    const d = res.details as Record<string, any>;
    expect(d.closed).toBe(true);
    expect(calls[0]!.body).toMatchObject({ action: "close", pid: 1234, force: true });
  });

  it("requires at least one identifier", async () => {
    const { client } = fakeClient(() => ({ ok: true, closed: true }));
    const tool = createAppCloseTool({ bridgeUrl: "x", clientOverride: client });
    await expect(tool.execute(ID, {})).rejects.toThrow(/pid OR title OR processName/);
  });

  it("hints to retry with force when nothing closed", async () => {
    const { client } = fakeClient(() => ({ ok: true, closed: false, count: 1, killed: 0, force: false }));
    const tool = createAppCloseTool({ bridgeUrl: "x", clientOverride: client });
    const res = await tool.execute(ID, { title: "App With Unsaved Changes" });
    const d = res.details as Record<string, any>;
    expect(d.closed).toBe(false);
    expect(d.hint).toContain("force: true");
  });
});
