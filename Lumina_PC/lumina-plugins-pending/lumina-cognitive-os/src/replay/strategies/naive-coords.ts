/**
 * naive_coords strategy — replay events at their recorded coordinates.
 *
 * Useful when:
 *   - Same machine, same resolution, app unchanged
 *   - Quick smoke test of a recording
 *
 * Maps non-actionable events (session.start, screencast.tick) → skip.
 */
import type { ReplayStrategy, ResolvedAction, StrategyContext } from "./types.js";

export const naiveCoordsStrategy: ReplayStrategy = {
  id: "naive_coords",
  description: "Replay coordinates verbatim. Fast, fragile.",
  async resolve(ctx: StrategyContext): Promise<ResolvedAction> {
    const e = ctx.recorded;
    switch (e.kind) {
      case "session.start":
      case "screencast.tick":
        return { kind: "skip", reason: `non-actionable event: ${e.kind}` };
      case "mouse.down":
      case "mouse.up": {
        if (!e.pos) return { kind: "skip", reason: "no pos" };
        // Treat down+up sequences as a single click in the engine — here just
        // emit a click on mouse.down and skip mouse.up to halve dispatches.
        if (e.kind === "mouse.up") return { kind: "skip", reason: "paired with mouse.down" };
        return {
          kind: "mouse_click",
          x: e.pos.x,
          y: e.pos.y,
          button: normalizeButton(e.button),
          clicks: 1,
          via: { source: "naive_coords" },
        };
      }
      case "mouse.scroll": {
        if (!e.pos) return { kind: "skip", reason: "no pos" };
        return {
          kind: "mouse_scroll",
          x: e.pos.x,
          y: e.pos.y,
          dx: e.dx ?? 0,
          dy: e.dy ?? 0,
          via: { source: "naive_coords" },
        };
      }
      case "key.down": {
        if (!e.key) return { kind: "skip", reason: "no key" };
        if (e.key.length === 1) {
          return { kind: "type_text", text: e.key, via: { source: "naive_coords" } };
        }
        return { kind: "key_press", keys: [e.key], via: { source: "naive_coords" } };
      }
      case "key.up":
        return { kind: "skip", reason: "paired with key.down" };
      default:
        return { kind: "skip", reason: `unknown kind: ${e.kind}` };
    }
  },
};

function normalizeButton(raw: string | undefined): "left" | "right" | "middle" {
  if (!raw) return "left";
  const v = raw.toLowerCase();
  if (v.includes("right")) return "right";
  if (v.includes("middle") || v.includes("3")) return "middle";
  return "left";
}
