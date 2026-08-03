/**
 * vision_grounded strategy — use OmniParser + Set-of-Marks to relocate
 * elements when UIA fails (Electron, canvas, games).
 *
 * This strategy needs:
 *   - the live screenshot (for OmniParser to parse)
 *   - the recorded screenshot (for the LLM to know what we WANTED to click)
 *
 * In this initial cut we don't actually call an LLM — we do a structural
 * match: take the recorded click position, find the closest detected
 * element in the live OmniParser output, and click its center.
 *
 * A future step can replace `pickClosestElement` with a real LLM judge
 * over Set-of-Marks. The interface stays the same.
 */
import type { ReplayStrategy, ResolvedAction, StrategyContext } from "./types.js";
import type { DetectedElement } from "../../vision/set-of-marks.js";

export type OmniParserClient = (params: {
  imagePath: string;
  setOfMarks?: boolean;
}) => Promise<{
  ok: boolean;
  elements?: DetectedElement[];
  error?: string;
}>;

let omniClient: OmniParserClient | null = null;

export function configureOmniParserClient(client: OmniParserClient | null): void {
  omniClient = client;
}

export const visionGroundedStrategy: ReplayStrategy = {
  id: "vision_grounded",
  description: "Use OmniParser to detect the closest element to the recorded click and re-target there.",
  async resolve(ctx: StrategyContext): Promise<ResolvedAction> {
    const e = ctx.recorded;
    if (e.kind !== "mouse.down") return forwardNaive(ctx);
    if (!e.pos) return { kind: "skip", reason: "no recorded pos" };
    if (!ctx.live.screenshotPath) {
      return { kind: "skip", reason: "no live screenshot available" };
    }
    if (!omniClient) {
      return { kind: "skip", reason: "OmniParser client not configured (vision sidecar not installed?)" };
    }
    const r = await omniClient({ imagePath: ctx.live.screenshotPath });
    if (!r.ok || !r.elements || r.elements.length === 0) {
      return { kind: "skip", reason: `OmniParser returned no elements: ${r.error ?? "empty"}` };
    }
    const match = pickClosestElement(r.elements, e.pos.x, e.pos.y);
    if (!match) return { kind: "skip", reason: "no element close enough" };
    const center = match.center ?? {
      x: match.bbox.x + Math.floor(match.bbox.w / 2),
      y: match.bbox.y + Math.floor(match.bbox.h / 2),
    };
    return {
      kind: "mouse_click",
      x: center.x,
      y: center.y,
      button: "left",
      clicks: 1,
      via: {
        source: "vision_grounded",
        confidence: match.confidence,
        rationale: `closest OmniParser element to recorded (${e.pos.x},${e.pos.y}): ${match.label ?? "(no label)"}`,
      },
      verifyPolicy: { kind: "screenshot_diff", minChangeRatio: 0.005 },
    };
  },
};

function pickClosestElement(
  elements: ReadonlyArray<DetectedElement>,
  x: number,
  y: number,
): DetectedElement | null {
  let best: { el: DetectedElement; dist: number } | null = null;
  for (const el of elements) {
    const c = el.center ?? {
      x: el.bbox.x + Math.floor(el.bbox.w / 2),
      y: el.bbox.y + Math.floor(el.bbox.h / 2),
    };
    const dx = c.x - x;
    const dy = c.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.dist) best = { el, dist };
  }
  // Require the closest element to be within 100 px (reasonable click tolerance).
  return best && best.dist <= 100 ? best.el : null;
}

async function forwardNaive(ctx: StrategyContext): Promise<ResolvedAction> {
  const { naiveCoordsStrategy } = await import("./naive-coords.js");
  return naiveCoordsStrategy.resolve(ctx);
}
