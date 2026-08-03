import { describe, expect, it } from "vitest";
import { CostMeter } from "./cost-meter.js";

describe("CostMeter", () => {
  it("records a Gemini Flash call and computes USD correctly", () => {
    const m = new CostMeter();
    const e = m.record({
      runId: "r1",
      iteration: 1,
      provider: "gemini",
      model: "gemini-2.5-flash",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    // 1M in @ $0.075 + 1M out @ $0.30 = $0.375
    expect(e.usd).toBeCloseTo(0.375, 4);
  });

  it("falls back to 0 for unknown provider/model", () => {
    const m = new CostMeter();
    const e = m.record({
      runId: "r1",
      iteration: 1,
      provider: "mysterio" as never,
      model: "v-unknown",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(e.usd).toBe(0);
  });

  it("treats Ollama as $0 (local)", () => {
    const m = new CostMeter();
    const e = m.record({
      runId: "r1",
      iteration: 1,
      provider: "ollama",
      model: "gemma4:31b",
      tokensIn: 5_000_000,
      tokensOut: 5_000_000,
    });
    expect(e.usd).toBe(0);
  });

  it("aggregates by provider+model in summary", () => {
    const m = new CostMeter();
    m.record({ runId: "r1", iteration: 1, provider: "gemini", model: "gemini-2.5-flash", tokensIn: 1_000_000, tokensOut: 0 });
    m.record({ runId: "r1", iteration: 2, provider: "gemini", model: "gemini-2.5-flash", tokensIn: 1_000_000, tokensOut: 0 });
    m.record({ runId: "r1", iteration: 3, provider: "openai", model: "gpt-4o-mini", tokensIn: 1_000_000, tokensOut: 1_000_000 });

    const s = m.summary();
    expect(s.totalCalls).toBe(3);
    expect(s.byProvider).toHaveLength(2);
    const gem = s.byProvider.find((p) => p.provider === "gemini")!;
    expect(gem.callCount).toBe(2);
    expect(gem.tokensIn).toBe(2_000_000);
    expect(gem.usd).toBeCloseTo(0.15, 4); // 2M * 0.075 / 1M
    const oa = s.byProvider.find((p) => p.provider === "openai")!;
    expect(oa.usd).toBeCloseTo(0.75, 4); // 1M*0.15 + 1M*0.60
  });

  it("uses prefix match for model variants (gemini-2.5-flash-image → flash pricing)", () => {
    const m = new CostMeter();
    const e = m.record({
      runId: "r1",
      iteration: 1,
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      tokensIn: 1_000_000,
      tokensOut: 0,
    });
    expect(e.usd).toBeCloseTo(0.075, 4);
  });
});
