import { describe, expect, it, vi } from "vitest";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";
import type { BridgeClient } from "../shared/bridge-client.js";
import { dispatchAction, type ToolRegistry } from "./action-dispatcher.js";
import type { BrainClient, LoopAction, ThinkParams, ThinkResult } from "./brain-gemini.js";
import {
  PcOperatorEngine,
  pickSkillForGoal,
  scoreSkillMatch,
  verifyObservationDelta,
  type ObserveResult,
  type SkillCatalog,
} from "./loop-engine.js";

function fakeTool(
  name: string,
  handler: (params: unknown) => unknown,
): AnyAgentTool {
  return {
    name,
    description: name,
    parameters: {} as AnyAgentTool["parameters"],
    execute: vi.fn(async (_id, params) => jsonResult(handler(params))),
  };
}

function fakeBridge(): {
  bridge: BridgeClient;
  posts: Array<{ path: string; body: unknown }>;
} {
  const posts: Array<{ path: string; body: unknown }> = [];
  return {
    posts,
    bridge: {
      bridgeUrl: "http://127.0.0.1:8765",
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body });
        return { ok: true, path, body };
      }) as BridgeClient["post"],
      get: vi.fn(async () => ({ ok: true })) as BridgeClient["get"],
    },
  };
}

function brainFrom(actions: LoopAction[]): BrainClient {
  let index = 0;
  return {
    think: vi.fn(async (_params: ThinkParams): Promise<ThinkResult> => {
      const action = actions[Math.min(index, actions.length - 1)];
      index += 1;
      if (!action) throw new Error("brain action queue is empty");
      return { action, tokensIn: 10, tokensOut: 5 };
    }),
  };
}

function baseTools(extra: Partial<ToolRegistry> = {}): ToolRegistry {
  return {
    pc_observe: fakeTool("lumina_pc_observe", () => ({
      ok: true,
      screenshotPath: "C:/tmp/lumina-shot.png",
      foreground: { name: "chrome.exe" },
      interactables: [{ name: "Search", controlType: "Edit", bbox: { x: 1, y: 2, w: 3, h: 4 } }],
      windows: [{ title: "Chrome" }],
    })),
    browser_dom_observe: fakeTool("lumina_browser_dom_observe", () => ({
      ok: true,
      elements: [{ name: "Search", role: "textbox", bbox: { x: 1, y: 2, w: 3, h: 4 } }],
    })),
    smart_click: fakeTool("lumina_smart_click", () => ({ ok: true, dispatched: true, verification: { ok: true } })),
    smart_type: fakeTool("lumina_smart_type", () => ({ ok: true, dispatched: true, verification: { ok: true } })),
    ...extra,
  };
}

describe("dispatchAction PC operator bridge actions", () => {
  it("opens URLs through the Windows Bridge using the default browser", async () => {
    const { bridge, posts } = fakeBridge();
    const result = await dispatchAction(
      { tools: {}, bridge, allowedApps: [] },
      { kind: "open_url", url: "youtube.com", reasoning: "open the site" },
    );

    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("bridge:open_url");
    expect(posts).toEqual([
      { path: "/open_application", body: { target: "https://youtube.com/" } },
    ]);
  });

  it("launches supported Windows apps through window_control", async () => {
    const { bridge, posts } = fakeBridge();
    const result = await dispatchAction(
      { tools: {}, bridge, allowedApps: [] },
      { kind: "open_application", application: "youtube", reasoning: "open YouTube" },
    );

    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("bridge:open_application");
    expect(posts).toEqual([
      { path: "/window_control", body: { action: "launch", application: "youtube" } },
    ]);
  });

  it("forwards unknown app names to Bridge for Get-StartApps fuzzy match", async () => {
    // The whitelist used to live in the dispatcher; now the Bridge handles
    // alias-or-fuzzy. Dispatcher should NOT reject unknown names; it forwards
    // and lets the Bridge respond ok or not_found.
    const posts: Array<{ path: string; body: unknown }> = [];
    const bridge = {
      bridgeUrl: "http://127.0.0.1:8765",
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body });
        return { ok: false, error: "no_match", via: "start_apps" };
      }) as BridgeClient["post"],
      get: vi.fn(async () => ({ ok: true })) as BridgeClient["get"],
    } as BridgeClient;
    const result = await dispatchAction(
      { tools: {}, bridge, allowedApps: [] },
      { kind: "open_application", application: "definitely-not-installed-app", reasoning: "fuzzy" },
    );

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("no_match");
    expect(posts).toEqual([
      {
        path: "/window_control",
        body: { action: "launch", application: "definitely-not-installed-app" },
      },
    ]);
  });

  it("closes apps gracefully via Bridge WM_CLOSE", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const bridge = {
      bridgeUrl: "http://127.0.0.1:8765",
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body });
        return { ok: true, closed: true, count: 1, killed: 1 };
      }) as BridgeClient["post"],
      get: vi.fn(async () => ({ ok: true })) as BridgeClient["get"],
    } as BridgeClient;
    const result = await dispatchAction(
      { tools: {}, bridge, allowedApps: [] },
      { kind: "close_application", title: "Notepad", reasoning: "close it" },
    );

    expect(result.ok).toBe(true);
    expect(result.verifiedByTool).toBe(true);
    expect(result.toolName).toBe("bridge:close_application");
    expect(posts).toEqual([
      {
        path: "/window_control",
        body: { action: "close", pid: undefined, title: "Notepad", processName: undefined, force: false },
      },
    ]);
  });

  it("rejects close_application with no target identifier", async () => {
    const { bridge, posts } = fakeBridge();
    const result = await dispatchAction(
      { tools: {}, bridge, allowedApps: [] },
      { kind: "close_application", reasoning: "no target" },
    );

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("requires pid");
    expect(posts).toEqual([]);
  });
});

describe("PcOperatorEngine", () => {
  it("runs observe -> open_url -> observe -> done in production", async () => {
    const { bridge, posts } = fakeBridge();
    const engine = new PcOperatorEngine({
      brain: brainFrom([
        { kind: "open_url", url: "https://www.youtube.com", reasoning: "open YouTube" },
        { kind: "done", summary: "YouTube is visible." },
      ]),
      tools: baseTools(),
      bridge,
      allowedApps: ["chrome.exe"],
    });

    const run = await engine.run({ goal: "abre YouTube", maxIterations: 4 });

    expect(run.status).toBe("done");
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]?.dispatch?.toolName).toBe("bridge:open_url");
    expect(posts[0]).toEqual({
      path: "/open_application",
      body: { target: "https://www.youtube.com/" },
    });
  });

  it("simulate mode records the brain action without dispatching it", async () => {
    const smartClick = fakeTool("lumina_smart_click", () => {
      throw new Error("should not run");
    });
    const { bridge, posts } = fakeBridge();
    const engine = new PcOperatorEngine({
      brain: brainFrom([
        { kind: "smart_click", query: "Play", reasoning: "click play" },
      ]),
      tools: baseTools({ smart_click: smartClick }),
      bridge,
      allowedApps: ["chrome.exe"],
    });

    const run = await engine.run({ goal: "click play", mode: "simulate", maxIterations: 1 });

    expect(run.status).toBe("max_iterations");
    expect(run.steps[0]?.dispatch).toMatchObject({
      ok: true,
      dispatched: false,
      toolName: "simulate:smart_click",
    });
    expect(smartClick.execute).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it("surfaces stuck actions as a terminal run state", async () => {
    const { bridge } = fakeBridge();
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "stuck", ask: "Which browser should I use?" }]),
      tools: baseTools(),
      bridge,
      allowedApps: ["chrome.exe"],
    });

    const run = await engine.run({ goal: "open a private site" });

    expect(run.status).toBe("stuck");
    expect(run.stuckReason).toBe("Which browser should I use?");
  });

  it("passes requested brain provider/model into the brain and records the actual choice", async () => {
    const think = vi.fn(async (params: ThinkParams): Promise<ThinkResult> => {
      expect(params.brainProvider).toBe("ollama");
      expect(params.brainModel).toBe("gemma4:31b");
      return {
        action: { kind: "done", summary: "done via Gemma4" },
        brainProvider: "ollama",
        brainModel: "gemma4:31b",
      };
    });
    const { bridge } = fakeBridge();
    const engine = new PcOperatorEngine({
      brain: { think },
      tools: baseTools(),
      bridge,
      allowedApps: ["chrome.exe"],
    });

    const run = await engine.run({
      goal: "usa Gemma4 para observar",
      brainProvider: "ollama",
      brainModel: "gemma4:31b",
    });

    expect(run.requestedBrainProvider).toBe("ollama");
    expect(run.requestedBrainModel).toBe("gemma4:31b");
    expect(run.steps[0]?.brainProvider).toBe("ollama");
    expect(run.steps[0]?.brainModel).toBe("gemma4:31b");
    expect(think).toHaveBeenCalledTimes(1);
  });
});

describe("OmniParser fallback in observe()", () => {
  it("calls vision_parse when UIA returned fewer than 5 interactables", async () => {
    const visionCalls: Array<Record<string, unknown>> = [];
    // pc_observe returns a nearly-blind digest (canvas/game surface).
    const tools: ToolRegistry = {
      pc_observe: fakeTool("lumina_pc_observe", () => ({
        ok: true,
        screenshotPath: "C:/tmp/canvas.png",
        foreground: { name: "notepad.exe" },
        interactables: [{ name: "OK", controlType: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 } }],
        windows: [{ title: "Canvas app" }],
      })),
      vision_parse: {
        name: "lumina_vision_parse",
        description: "vision parse",
        parameters: {} as AnyAgentTool["parameters"],
        execute: vi.fn(async (_id, params) => {
          visionCalls.push(params as Record<string, unknown>);
          return jsonResult({
            ok: true,
            elements: [
              { label: "Play", type: "icon", bbox: { x: 40, y: 40, w: 32, h: 32 } },
              { text: "Continue", type: "text", bbox: { x: 100, y: 40, w: 90, h: 20 } },
            ],
          });
        }),
      },
      smart_click: fakeTool("lumina_smart_click", () => ({ ok: true, dispatched: true })),
    };
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "done", summary: "ok" }]),
      tools,
      bridge: fakeBridge().bridge,
      allowedApps: [],
    });
    const run = await engine.run({ goal: "click Play" });
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]).toMatchObject({
      imagePath: "C:/tmp/canvas.png",
      setOfMarks: false,
    });
    const interactables = run.steps[0]?.observation.interactables ?? [];
    // 1 from UIA + 2 from vision_parse.
    expect(interactables.length).toBeGreaterThanOrEqual(3);
    const roles = interactables.map((i) => (i as { role?: string }).role ?? null);
    expect(roles.some((r) => r?.startsWith("vision:"))).toBe(true);
  });

  it("does NOT call vision_parse when UIA already returned 5+ interactables", async () => {
    const visionSpy = vi.fn(async () => jsonResult({ ok: true, elements: [] }));
    const richInteractables = Array.from({ length: 6 }, (_, i) => ({
      name: `btn${i}`,
      controlType: "Button",
      bbox: { x: i * 10, y: 0, w: 8, h: 8 },
    }));
    const tools: ToolRegistry = {
      pc_observe: fakeTool("lumina_pc_observe", () => ({
        ok: true,
        screenshotPath: "C:/tmp/shot.png",
        foreground: { name: "notepad.exe" },
        interactables: richInteractables,
        windows: [{ title: "App" }],
      })),
      vision_parse: {
        name: "lumina_vision_parse",
        description: "vision parse",
        parameters: {} as AnyAgentTool["parameters"],
        execute: visionSpy,
      },
      smart_click: fakeTool("lumina_smart_click", () => ({ ok: true, dispatched: true })),
    };
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "done", summary: "ok" }]),
      tools,
      bridge: fakeBridge().bridge,
      allowedApps: [],
    });
    await engine.run({ goal: "click a button" });
    expect(visionSpy).not.toHaveBeenCalled();
  });
});

describe("verifyObservationDelta", () => {
  const empty: ObserveResult = { screenshotPath: null, digest: {} };
  const shotA: ObserveResult = {
    screenshotPath: "C:/tmp/a.png",
    digest: { foregroundProcess: "chrome.exe", interactables: [], windowTitles: ["YouTube"] },
  };
  const shotB: ObserveResult = {
    screenshotPath: "C:/tmp/b.png",
    digest: { foregroundProcess: "chrome.exe", interactables: [], windowTitles: ["YouTube — Playing"] },
  };
  const shotC: ObserveResult = {
    screenshotPath: "C:/tmp/a.png",
    digest: { foregroundProcess: "spotify.exe", interactables: [], windowTitles: ["Spotify"] },
  };

  it("reports changed when the screenshot path renewed", () => {
    const v = verifyObservationDelta(shotA, shotB);
    expect(v.changed).toBe(true);
    expect(v.changedFields).toContain("screenshotPath");
    expect(v.changedFields).toContain("windowTitles");
  });

  it("reports changed when the foreground process switched", () => {
    const v = verifyObservationDelta(shotA, shotC);
    expect(v.changed).toBe(true);
    expect(v.changedFields).toContain("foregroundProcess");
  });

  it("reports unchanged when nothing meaningful moved", () => {
    const v = verifyObservationDelta(shotA, shotA);
    expect(v.changed).toBe(false);
    expect(v.changedFields).toEqual([]);
  });

  it("handles the empty observation shape safely", () => {
    const v = verifyObservationDelta(empty, empty);
    expect(v.changed).toBe(false);
    expect(v.method).toBe("observation-delta");
  });
});

describe("Skill-first shortcut", () => {
  const catalog: SkillCatalog = {
    list: () => [
      { id: "poner-musica", description: "Abre YouTube o Spotify y reproduce música favorita" },
      { id: "cerrar-todo", description: "Cierra todas las ventanas del escritorio" },
    ],
  };

  it("scoreSkillMatch is proportional to overlapping keywords", () => {
    const a = scoreSkillMatch("pon música", { id: "poner-musica", description: "reproduce música" });
    const b = scoreSkillMatch("cerrar todas", {
      id: "cerrar-todo",
      description: "Cierra todas las ventanas del escritorio",
    });
    const c = scoreSkillMatch("pon música", {
      id: "cerrar-todo",
      description: "Cierra todas las ventanas del escritorio",
    });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(c).toBe(0);
  });

  it("pickSkillForGoal returns the highest-scoring skill above threshold", () => {
    const pick = pickSkillForGoal("pon música favorita", catalog, 0.1);
    expect(pick).not.toBeNull();
    expect(pick?.skillId).toBe("poner-musica");
  });

  it("pickSkillForGoal returns null when nothing beats the threshold", () => {
    const pick = pickSkillForGoal("busca vuelos a Tokio", catalog, 0.4);
    expect(pick).toBeNull();
  });

  it("delegates to skillRunner when a skill matches (loop is skipped)", async () => {
    const thinkSpy = vi.fn();
    const runnerSpy = vi.fn(async () => ({ ok: true, summary: "played on Spotify" }));
    const engine = new PcOperatorEngine({
      brain: { think: thinkSpy as unknown as BrainClient["think"] },
      tools: baseTools(),
      bridge: fakeBridge().bridge,
      allowedApps: [],
      skillCatalog: catalog,
      skillRunner: runnerSpy,
      skillMatchThreshold: 0.15,
    });
    const run = await engine.run({ goal: "pon música favorita" });
    expect(thinkSpy).not.toHaveBeenCalled();
    expect(runnerSpy).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("done");
    expect(run.finalSummary).toBe("played on Spotify");
    expect(run.steps).toHaveLength(0);
  });

  it("falls back to the loop when skillRunner throws", async () => {
    const runnerSpy = vi.fn(async () => {
      throw new Error("broken recipe");
    });
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "done", summary: "fallback ok" }]),
      tools: baseTools(),
      bridge: fakeBridge().bridge,
      allowedApps: [],
      skillCatalog: catalog,
      skillRunner: runnerSpy,
      skillMatchThreshold: 0.15,
    });
    const run = await engine.run({ goal: "pon música favorita" });
    expect(runnerSpy).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("done");
    expect(run.finalSummary).toBe("fallback ok");
    expect(run.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("simulate mode never triggers the skill shortcut", async () => {
    const runnerSpy = vi.fn();
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "done", summary: "simulate ok" }]),
      tools: baseTools(),
      bridge: fakeBridge().bridge,
      allowedApps: [],
      skillCatalog: catalog,
      skillRunner: runnerSpy as unknown as (p: {
        readonly skillId: string;
        readonly goal: string;
        readonly runId: string;
      }) => Promise<{ readonly ok: boolean; readonly summary: string }>,
      skillMatchThreshold: 0.15,
    });
    await engine.run({ goal: "pon música favorita", mode: "simulate" });
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  it("fires onLoopSuccess when the classic loop finishes done", async () => {
    const onLoopSuccess = vi.fn();
    const engine = new PcOperatorEngine({
      brain: brainFrom([{ kind: "done", summary: "great" }]),
      tools: baseTools(),
      bridge: fakeBridge().bridge,
      allowedApps: [],
      onLoopSuccess,
    });
    const run = await engine.run({ goal: "click Play" });
    expect(run.status).toBe("done");
    expect(onLoopSuccess).toHaveBeenCalledTimes(1);
    expect(onLoopSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "click Play", finalSummary: "great" }),
    );
  });
});
