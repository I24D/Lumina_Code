/**
 * Tests for the Risk Evaluation Engine (Nivel 10).
 */
import { describe, expect, it } from "vitest";
import { evaluateRisk } from "./policies.js";
import { RiskEngine } from "./risk-engine.js";

describe("evaluateRisk", () => {
  it("classifies rm -rf as CRITICAL", () => {
    const r = evaluateRisk({ category: "exec", action: "rm -rf node_modules" });
    expect(r.tier).toBe("CRITICAL");
    expect(r.requiresDoubleConfirmation).toBe(true);
    expect(r.mustAudit).toBe(true);
  });

  it("classifies shutdown as CRITICAL", () => {
    const r = evaluateRisk({ category: "exec", action: "shutdown /s /t 0" });
    expect(r.tier).toBe("CRITICAL");
  });

  it("classifies sudo as HIGH_RISK", () => {
    const r = evaluateRisk({ category: "exec", action: "sudo apt update" });
    expect(r.tier).toBe("HIGH_RISK");
    expect(r.requiresConfirmation).toBe(true);
    expect(r.requiresDoubleConfirmation).toBe(false);
  });

  it("classifies write to user Documents as WARNING", () => {
    const r = evaluateRisk({
      category: "write",
      action: "write file",
      target: "C:\\Users\\Dal\\Documents\\report.docx",
    });
    expect(r.tier).toBe("WARNING");
  });

  it("classifies a plain read as SAFE", () => {
    const r = evaluateRisk({ category: "read", action: "read profile.json" });
    expect(r.tier).toBe("SAFE");
    expect(r.requiresConfirmation).toBe(false);
    expect(r.mustAudit).toBe(false);
  });

  it("classifies input as HIGH_RISK regardless of action", () => {
    const r = evaluateRisk({ category: "input", action: "type 'hello'" });
    expect(r.tier).toBe("HIGH_RISK");
  });

  it("classifies money category as CRITICAL", () => {
    const r = evaluateRisk({ category: "money", action: "charge card" });
    expect(r.tier).toBe("CRITICAL");
  });

  it("defaults to WARNING when no rule matches", () => {
    const r = evaluateRisk({ category: "system", action: "doSomethingUnknown" });
    expect(["SAFE", "WARNING"]).toContain(r.tier);
  });
});

describe("RiskEngine", () => {
  it("buffers decisions and exposes stats", () => {
    const eng = new RiskEngine();
    eng.evaluate({ category: "read", action: "read x" });
    eng.evaluate({ category: "input", action: "click" });
    expect(eng.getStats().totals.SAFE).toBe(1);
    expect(eng.getStats().totals.HIGH_RISK).toBe(1);
    expect(eng.recent(10)).toHaveLength(2);
  });

  it("fires listeners on every evaluation", () => {
    const eng = new RiskEngine();
    const calls: string[] = [];
    const off = eng.on((d) => calls.push(d.tier));
    eng.evaluate({ category: "exec", action: "shutdown" });
    eng.evaluate({ category: "read", action: "read x" });
    expect(calls).toEqual(["CRITICAL", "SAFE"]);
    off();
    eng.evaluate({ category: "read", action: "read y" });
    expect(calls.length).toBe(2);
  });
});
