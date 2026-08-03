/**
 * hybrid strategy — try uia_grounded first; on skip/fail, fall back to
 * vision_grounded; on its skip too, fall back to naive_coords.
 *
 * Recommended default for skills shared across machines.
 */
import type { ReplayStrategy, ResolvedAction, StrategyContext } from "./types.js";
import { uiaGroundedStrategy } from "./uia-grounded.js";
import { visionGroundedStrategy } from "./vision-grounded.js";
import { naiveCoordsStrategy } from "./naive-coords.js";

export const hybridStrategy: ReplayStrategy = {
  id: "hybrid",
  description: "uia_grounded → vision_grounded → naive_coords fallback chain.",
  async resolve(ctx: StrategyContext): Promise<ResolvedAction> {
    const e = ctx.recorded;
    // Non-positional events: naive is fine.
    if (e.kind !== "mouse.down") {
      return naiveCoordsStrategy.resolve(ctx);
    }
    const uiaResult = await uiaGroundedStrategy.resolve(ctx);
    if (uiaResult.kind !== "skip") {
      return { ...uiaResult, via: { source: "hybrid", chosen: "uia" } } as ResolvedAction;
    }
    const visionResult = await visionGroundedStrategy.resolve(ctx);
    if (visionResult.kind !== "skip") {
      return {
        ...visionResult,
        via: { source: "hybrid", chosen: "vision", reason: uiaResult.reason },
      } as ResolvedAction;
    }
    return naiveCoordsStrategy.resolve(ctx);
  },
};
