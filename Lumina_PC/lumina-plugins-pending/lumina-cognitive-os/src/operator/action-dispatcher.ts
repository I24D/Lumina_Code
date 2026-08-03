/**
 * action-dispatcher.ts — Maps a LoopAction from the brain to a concrete
 * tool execution.
 *
 * The dispatcher does NOT own any I/O of its own — it forwards to the
 * already-registered cognitive-os tools (smart_click, smart_type, etc.)
 * and to a tiny Bridge client for the few raw verbs that don't have a
 * smart wrapper (window_focus, key_press, shortcut).
 *
 * Returns a normalized { ok, dispatched, verification, raw } that the
 * loop engine uses to decide whether to re-think with the same goal,
 * abort, or report success.
 */
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { BridgeClient } from "../shared/bridge-client.js";
import type { LoopAction } from "./brain-gemini.js";
import { killSwitch } from "./kill-switch.js";

export type ToolRegistry = {
  readonly smart_click?: AnyAgentTool;
  readonly smart_type?: AnyAgentTool;
  readonly pc_scroll?: AnyAgentTool;
  readonly pc_drag?: AnyAgentTool;
  readonly pc_observe?: AnyAgentTool;
  readonly browser_smart_click?: AnyAgentTool;
  readonly browser_smart_type?: AnyAgentTool;
  readonly browser_dom_observe?: AnyAgentTool;
  readonly browser_dom_screenshot?: AnyAgentTool;
  /**
   * Optional OmniParser (lumina_vision_parse) fallback. When the UIA
   * observation returns few or no interactables — typical for Electron,
   * canvas-based apps and games — the loop engine calls this to enrich
   * the digest with semantic visual elements. Not required for the loop
   * to work; when absent the engine skips this enrichment silently.
   */
  readonly vision_parse?: AnyAgentTool;
};

export type DispatchResult = {
  readonly ok: boolean;
  readonly dispatched: boolean;
  readonly verifiedByTool: boolean | null;
  readonly toolName: string;
  readonly errorMessage?: string;
  readonly raw?: unknown;
};

export type DispatcherDeps = {
  readonly tools: ToolRegistry;
  readonly bridge: BridgeClient;
  readonly allowedApps: ReadonlyArray<string>;
};

// NOTE: the whitelist used to live here, but Codex/Claude moved validation
// into the Bridge handler. The Bridge now: (1) tries the alias map (~70
// curated names), (2) falls back to Get-StartApps fuzzy match. So the
// dispatcher just forwards. The brain is told which aliases exist in
// SYSTEM_PROMPT; anything else goes through the fuzzy path automatically.

async function callTool(tool: AnyAgentTool | undefined, params: Record<string, unknown>, toolName: string): Promise<DispatchResult> {
  if (!tool) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName,
      errorMessage: `tool ${toolName} not registered in PC Operator`,
    };
  }
  try {
    const r = await tool.execute("loop", params);
    const details = (r as unknown as { details?: Record<string, unknown> }).details ?? {};
    const ok = details.ok === true;
    // For tools that report a verification block, surface verification.ok
    // as the authoritative "did the screen actually change" signal.
    const verification = details.verification as { ok?: boolean } | undefined;
    const verifiedFromVerification = typeof verification?.ok === "boolean" ? verification.ok : null;
    // For browser tools: the field is `verified` at the top level.
    const verifiedFromBrowser = typeof details.verified === "boolean" ? (details.verified as boolean) : null;
    const verifiedByTool = verifiedFromVerification ?? verifiedFromBrowser;
    return {
      ok,
      dispatched: details.dispatched === true || ok,
      verifiedByTool,
      toolName,
      errorMessage: typeof details.error === "string" ? details.error : undefined,
      raw: details,
    };
  } catch (e) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName,
      errorMessage: (e as Error).message,
    };
  }
}

async function dispatchKeyPress(
  bridge: BridgeClient,
  allowedApps: ReadonlyArray<string>,
  keys: string[],
  action: "key_press" | "shortcut",
): Promise<DispatchResult> {
  const resp = await bridge.post<{ ok?: boolean; allowed?: boolean; error?: string }>("/input_control", {
    action,
    keys,
    wait_ms: 100,
    allowedApps,
  }, 6_000);
  if (!resp) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: `bridge:${action}`,
      errorMessage: "bridge_unreachable",
    };
  }
  return {
    ok: resp.ok === true,
    dispatched: resp.ok === true,
    verifiedByTool: null,
    toolName: `bridge:${action}`,
    errorMessage: resp.error,
    raw: resp,
  };
}

async function dispatchWindowFocus(bridge: BridgeClient, title: string): Promise<DispatchResult> {
  const resp = await bridge.post<{ ok?: boolean; focused?: unknown; error?: string }>(
    "/window_control",
    { action: "focus", title },
    4_000,
  );
  if (!resp) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:window_focus",
      errorMessage: "bridge_unreachable",
    };
  }
  return {
    ok: resp.ok === true,
    dispatched: resp.ok === true,
    verifiedByTool: null,
    toolName: "bridge:window_focus",
    errorMessage: resp.error,
    raw: resp,
  };
}

async function dispatchOpenApplication(bridge: BridgeClient, application: string): Promise<DispatchResult> {
  const normalized = application.trim();
  if (!normalized) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:open_application",
      errorMessage: "application is required",
    };
  }
  const resp = await bridge.post<{
    ok?: boolean;
    launched?: unknown;
    error?: string;
    via?: string;
    alternatives?: Array<{ name: string; appId: string }>;
  }>("/window_control", { action: "launch", application: normalized.toLowerCase() }, 18_000);
  if (!resp) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:open_application",
      errorMessage: "bridge_unreachable",
    };
  }
  return {
    ok: resp.ok === true,
    dispatched: resp.ok === true,
    verifiedByTool: null,
    toolName: "bridge:open_application",
    errorMessage: resp.error,
    raw: resp,
  };
}

async function dispatchCloseApplication(
  bridge: BridgeClient,
  params: { pid?: number; title?: string; processName?: string; force?: boolean },
): Promise<DispatchResult> {
  if (params.pid === undefined && !params.title && !params.processName) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:close_application",
      errorMessage: "close_application requires pid, title, or processName",
    };
  }
  const resp = await bridge.post<{
    ok?: boolean;
    closed?: boolean;
    count?: number;
    killed?: number;
    error?: string;
  }>(
    "/window_control",
    {
      action: "close",
      pid: params.pid,
      title: params.title,
      processName: params.processName,
      force: params.force === true,
    },
    15_000,
  );
  if (!resp) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:close_application",
      errorMessage: "bridge_unreachable",
    };
  }
  return {
    ok: resp.ok === true && resp.closed === true,
    dispatched: resp.ok === true,
    verifiedByTool: resp.closed === true ? true : null,
    toolName: "bridge:close_application",
    errorMessage: resp.error,
    raw: resp,
  };
}

function normalizeUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function dispatchOpenUrl(
  bridge: BridgeClient,
  rawUrl: string,
  browser: "default" | "edge" | undefined,
): Promise<DispatchResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:open_url",
      errorMessage: `invalid url: ${rawUrl}`,
    };
  }
  const target = browser === "edge" ? `microsoft-edge:${url}` : url;
  const resp = await bridge.post<{ ok?: boolean; error?: string }>(
    "/open_application",
    { target },
    8_000,
  );
  if (!resp) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "bridge:open_url",
      errorMessage: "bridge_unreachable",
    };
  }
  return {
    ok: resp.ok === true,
    dispatched: resp.ok === true,
    verifiedByTool: null,
    toolName: "bridge:open_url",
    errorMessage: resp.error,
    raw: { ...resp, url, browser: browser ?? "default" },
  };
}

export async function dispatchAction(deps: DispatcherDeps, action: LoopAction): Promise<DispatchResult> {
  const { tools, bridge, allowedApps } = deps;
  // §9 kill switch: refuse to dispatch ANY action while frozen, so no click /
  // type / scroll reaches the Bridge even if a plan is already in flight.
  if (killSwitch.isEngaged()) {
    return {
      ok: false,
      dispatched: false,
      verifiedByTool: null,
      toolName: "kill_switch",
      errorMessage: `kill_switch_engaged: ${killSwitch.getState().reason ?? "manual"}`,
    };
  }
  switch (action.kind) {
    case "open_application":
      return dispatchOpenApplication(bridge, action.application);

    case "close_application":
      return dispatchCloseApplication(bridge, {
        pid: action.pid,
        title: action.title,
        processName: action.processName,
        force: action.force,
      });

    case "open_url":
      return dispatchOpenUrl(bridge, action.url, action.browser);

    case "smart_click":
      return callTool(tools.smart_click, {
        query: action.query,
        processName: action.processName,
        clicks: action.clicks,
        controlType: action.controlType,
        allowVision: action.allowVision,
      }, "lumina_smart_click");

    case "smart_type":
      return callTool(tools.smart_type, {
        query: action.query,
        text: action.text,
        pressEnter: action.pressEnter,
      }, "lumina_smart_type");

    case "pc_scroll":
      return callTool(tools.pc_scroll, {
        direction: action.direction,
        amount: action.amount,
        query: action.query,
      }, "lumina_pc_scroll");

    case "pc_drag":
      return callTool(tools.pc_drag, {
        fromQuery: action.fromQuery,
        fromX: action.fromX,
        fromY: action.fromY,
        toQuery: action.toQuery,
        toX: action.toX,
        toY: action.toY,
        button: action.button,
      }, "lumina_pc_drag");

    case "browser_smart_click":
      return callTool(tools.browser_smart_click, {
        query: action.query,
        role: action.role,
        exact: action.exact,
      }, "lumina_browser_smart_click");

    case "browser_smart_type":
      return callTool(tools.browser_smart_type, {
        query: action.query,
        text: action.text,
        pressEnter: action.pressEnter,
      }, "lumina_browser_smart_type");

    case "key_press":
      return dispatchKeyPress(bridge, allowedApps, action.keys, "key_press");

    case "shortcut":
      return dispatchKeyPress(bridge, allowedApps, action.keys, "shortcut");

    case "window_focus":
      return dispatchWindowFocus(bridge, action.title);

    case "wait": {
      const ms = Math.max(0, Math.min(10_000, action.ms));
      await new Promise((r) => setTimeout(r, ms));
      return {
        ok: true,
        dispatched: true,
        verifiedByTool: null,
        toolName: "wait",
        raw: { waited: ms },
      };
    }

    case "done":
    case "stuck":
      // Terminal actions never dispatch; the engine handles them.
      return {
        ok: true,
        dispatched: false,
        verifiedByTool: null,
        toolName: action.kind,
      };
  }
}
