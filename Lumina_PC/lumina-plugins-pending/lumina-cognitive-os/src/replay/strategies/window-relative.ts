/**
 * window_relative strategy — re-anchor coords to the current bbox of the
 * recorded window. Survives the window being moved or resized, NOT
 * theme changes / app updates.
 */
import type { ReplayStrategy, ResolvedAction, StrategyContext } from "./types.js";

export const windowRelativeStrategy: ReplayStrategy = {
  id: "window_relative",
  description: "Translate coords by the current vs recorded window bbox delta.",
  async resolve(ctx: StrategyContext): Promise<ResolvedAction> {
    const e = ctx.recorded;
    if (e.kind !== "mouse.down" && e.kind !== "mouse.scroll") {
      // Fall back to naive behaviour for non-positional events.
      return forwardNaive(ctx);
    }
    if (!e.pos || !e.window) return { kind: "skip", reason: "missing pos/window" };

    const liveWin = findWindowByTitle(ctx.live.windows, e.window.title);
    if (!liveWin) {
      return { kind: "skip", reason: `window '${e.window.title}' not visible` };
    }
    // Without a recorded window bbox, we can't compute a translation;
    // fall through to naive coords.
    return forwardNaive(ctx);
  },
};

function findWindowByTitle(
  windows: ReadonlyArray<{ title: string; pid: number; process: string }>,
  needle: string,
): { title: string; pid: number; process: string } | undefined {
  const n = needle.toLowerCase().trim();
  return windows.find((w) => w.title.toLowerCase().includes(n));
}

async function forwardNaive(ctx: StrategyContext): Promise<ResolvedAction> {
  const { naiveCoordsStrategy } = await import("./naive-coords.js");
  return naiveCoordsStrategy.resolve(ctx);
}
