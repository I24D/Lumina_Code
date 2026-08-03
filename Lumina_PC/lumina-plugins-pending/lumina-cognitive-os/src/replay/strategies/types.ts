/**
 * Replay strategy interface.
 *
 * A Strategy is the policy that turns a recorded event ("click at
 * (842,567) when the window was 'Notepad'") into a CONCRETE action
 * targeting the CURRENT desktop state. Different strategies handle
 * different amounts of drift:
 *
 *   naive_coords    — replay exact coords (only works in same env)
 *   window_relative — coords relative to the recorded window's bbox,
 *                     re-anchored to that window's CURRENT bbox
 *   uia_grounded    — re-find the recorded element by automationId/name
 *                     in the live UIA tree and click its center
 *   vision_grounded — re-find via OmniParser + Set-of-Marks LLM choice
 *   hybrid          — try uia_grounded; fall back to vision_grounded
 *
 * Strategies are pure planning — they DON'T call lumina_input_control.
 * The engine takes the resolved Action and dispatches via the Bridge.
 */
import type { RecordingEvent } from "../../recorder/recorder-store.js";

export type ResolvedAction =
  | { kind: "skip"; reason: string; verifyPolicy?: VerifyPolicy }
  | {
      kind: "mouse_click";
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      clicks: number;
      verifyPolicy?: VerifyPolicy;
      via: ResolutionPath;
    }
  | {
      kind: "mouse_move";
      x: number;
      y: number;
      via: ResolutionPath;
    }
  | {
      kind: "mouse_scroll";
      x: number;
      y: number;
      dx: number;
      dy: number;
      via: ResolutionPath;
    }
  | {
      kind: "type_text";
      text: string;
      via: ResolutionPath;
    }
  | {
      kind: "key_press";
      keys: string[];
      via: ResolutionPath;
    }
  | {
      kind: "wait";
      ms: number;
    };

export type ResolutionPath =
  | { source: "naive_coords" }
  | { source: "window_relative"; recordedWindow: string; currentWindow: string; rel: { x: number; y: number } }
  | { source: "uia_grounded"; automationId?: string; name?: string; matchScore?: number }
  | { source: "vision_grounded"; markId?: string; confidence?: number; rationale?: string }
  | { source: "hybrid"; chosen: "uia" | "vision"; reason?: string };

export type VerifyPolicy =
  | { kind: "none" }
  | { kind: "uia_recheck"; expect: { automationId?: string; name?: string } }
  | { kind: "screenshot_diff"; minChangeRatio: number }
  | { kind: "llm_judge"; prompt: string };

export type LiveContext = {
  /** Path to a freshly captured screenshot of the desktop right now. */
  readonly screenshotPath: string | null;
  /** Current foreground UIA tree (subset). May be null if UIA unavailable. */
  readonly uiaNodes: ReadonlyArray<LiveUiaNode> | null;
  /** Currently visible windows from the bridge /window_control list. */
  readonly windows: ReadonlyArray<{ title: string; pid: number; process: string }>;
  /** Resolution / DPI hint for coord adjustments. */
  readonly screen?: { width: number; height: number };
};

export type LiveUiaNode = {
  readonly name?: string;
  readonly automationId?: string;
  readonly controlType?: string;
  readonly className?: string;
  readonly bbox?: { x: number; y: number; w: number; h: number };
  readonly center?: { x: number; y: number };
};

export type StrategyContext = {
  readonly recorded: RecordingEvent;
  readonly live: LiveContext;
  readonly recordingDir: string;
  readonly dryRun: boolean;
};

export interface ReplayStrategy {
  readonly id: string;
  readonly description: string;
  resolve(ctx: StrategyContext): Promise<ResolvedAction>;
}

export const ALL_STRATEGY_IDS = [
  "naive_coords",
  "window_relative",
  "uia_grounded",
  "vision_grounded",
  "hybrid",
] as const;
export type StrategyId = (typeof ALL_STRATEGY_IDS)[number];
