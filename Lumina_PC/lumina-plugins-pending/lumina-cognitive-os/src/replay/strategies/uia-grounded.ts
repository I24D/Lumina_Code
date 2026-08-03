/**
 * uia_grounded strategy — re-find the recorded element by automationId
 * (preferred) or by name in the LIVE UIA tree, click its center.
 *
 * This is the most robust strategy when the target app has a decent UIA
 * implementation (Notepad, Office, most native Windows apps). Fails on:
 *   - Electron apps that don't expose UIA
 *   - Apps drawing on a single canvas (games, custom widgets)
 *   - When the target's name was localized differently
 *
 * The recording must include a `recorded.element` snapshot (which our
 * recorder.py extracts when captureUia is true). If absent, falls back
 * to naive coords.
 */
import type { ReplayStrategy, ResolvedAction, StrategyContext, LiveUiaNode } from "./types.js";

export const uiaGroundedStrategy: ReplayStrategy = {
  id: "uia_grounded",
  description: "Re-locate the recorded element in the live UIA tree by automationId or name.",
  async resolve(ctx: StrategyContext): Promise<ResolvedAction> {
    const e = ctx.recorded;
    if (e.kind !== "mouse.down") {
      // For non-click events, defer to naive (typing, scroll, etc).
      return forwardNaive(ctx);
    }
    const recordedTarget = pickRecordedTarget(ctx);
    if (!recordedTarget) {
      return { kind: "skip", reason: "no recorded UIA target to match" };
    }
    if (!ctx.live.uiaNodes || ctx.live.uiaNodes.length === 0) {
      return { kind: "skip", reason: "no live UIA tree available" };
    }
    const match = bestUiaMatch(recordedTarget, ctx.live.uiaNodes);
    if (!match) {
      return { kind: "skip", reason: `recorded UIA element not found in live tree` };
    }
    const center = match.node.center ?? (match.node.bbox
      ? {
          x: match.node.bbox.x + Math.floor(match.node.bbox.w / 2),
          y: match.node.bbox.y + Math.floor(match.node.bbox.h / 2),
        }
      : null);
    if (!center) {
      return { kind: "skip", reason: "matched node has no bbox" };
    }
    return {
      kind: "mouse_click",
      x: center.x,
      y: center.y,
      button: "left",
      clicks: 1,
      via: {
        source: "uia_grounded",
        automationId: match.node.automationId,
        name: match.node.name,
        matchScore: match.score,
      },
      verifyPolicy: { kind: "uia_recheck", expect: { automationId: match.node.automationId } },
    };
  },
};

type RecordedTarget = { automationId?: string; name?: string; controlType?: string };

function pickRecordedTarget(ctx: StrategyContext): RecordedTarget | null {
  // The recorder writes `element` only on enriched events; otherwise we
  // can search the UIA snapshot file. The engine handles loading; here
  // we use whichever is in scope.
  const enriched = (ctx.recorded as unknown as { element?: RecordedTarget }).element;
  if (enriched && (enriched.automationId || enriched.name)) return enriched;
  return null;
}

function bestUiaMatch(
  target: RecordedTarget,
  nodes: ReadonlyArray<LiveUiaNode>,
): { node: LiveUiaNode; score: number } | null {
  let best: { node: LiveUiaNode; score: number } | null = null;
  for (const n of nodes) {
    const score = scoreMatch(target, n);
    if (score > (best?.score ?? 0)) {
      best = { node: n, score };
    }
  }
  return best && best.score >= 0.4 ? best : null;
}

function scoreMatch(target: RecordedTarget, n: LiveUiaNode): number {
  let s = 0;
  if (target.automationId && n.automationId && target.automationId === n.automationId) s = 1.0;
  else if (target.name && n.name && target.name === n.name) s = Math.max(s, 0.85);
  else if (target.name && n.name && n.name.toLowerCase().includes(target.name.toLowerCase())) {
    s = Math.max(s, 0.6);
  }
  if (target.controlType && n.controlType === target.controlType) s += 0.05;
  return Math.min(1.0, s);
}

async function forwardNaive(ctx: StrategyContext): Promise<ResolvedAction> {
  const { naiveCoordsStrategy } = await import("./naive-coords.js");
  return naiveCoordsStrategy.resolve(ctx);
}
