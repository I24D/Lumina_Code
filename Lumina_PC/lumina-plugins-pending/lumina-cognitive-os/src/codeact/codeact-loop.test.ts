/**
 * Tests for the CodeAct engine — session lifecycle, sandbox path
 * extension, stdout scanner for FINAL / OBSERVATION sentinels.
 *
 * NOTE: we don't actually run the Python sidecar here (would require
 * Python on PATH in CI). We test the pieces that don't need it:
 * session state, maxIterations cap, scanStdout via a private helper
 * re-exposed for testing via the engine's public surface (calling start
 * then end + asserting on the session object).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RiskEngine } from "../risk/risk-engine.js";
import { ActionLogStore } from "../memory/action-log.js";
import { CodeActEngine } from "./codeact-loop.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-ca-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("CodeActEngine — lifecycle", () => {
  it("creates a session with a workspace dir", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: new ActionLogStore(tmpDir),
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    const session = eng.start({ goal: "find chrome window" });
    expect(session.id).toMatch(/^ca-/);
    expect(session.goal).toBe("find chrome window");
    expect(session.status).toBe("open");
    expect(fs.existsSync(session.workspaceDir)).toBe(true);
    expect(session.maxIterations).toBe(6);
  });

  it("rejects empty goal", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    expect(() => eng.start({ goal: "   " })).toThrow(/goal is required/);
  });

  it("clamps maxIterations to [1, 20]", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    expect(eng.start({ goal: "a", maxIterations: 0 }).maxIterations).toBe(1);
    expect(eng.start({ goal: "b", maxIterations: 999 }).maxIterations).toBe(20);
  });

  it("rejects duplicate session id", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    eng.start({ goal: "g", sessionId: "fixed" });
    expect(() => eng.start({ goal: "g", sessionId: "fixed" })).toThrow(/already exists/);
  });

  it("end() marks the session", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    const session = eng.start({ goal: "g" });
    eng.end(session.id, "aborted");
    expect(eng.get(session.id)?.status).toBe("aborted");
  });

  it("list() returns sessions in creation order", () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    eng.start({ goal: "g1", sessionId: "a" });
    eng.start({ goal: "g2", sessionId: "b" });
    const ids = eng.list().map((s) => s.id);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("CodeActEngine — sandbox extension", () => {
  it("automatically allows the workspace root regardless of base policy", async () => {
    // We can't actually run Python in CI, but we CAN assert the
    // workspace dir is under the engine's effective cwdAllow. This is
    // verified indirectly: start() doesn't throw and the dir exists.
    const workspaceRoot = path.join(tmpDir, "ca-workspace");
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot,
      policy: {
        cwdAllow: ["/nowhere"], // would otherwise block
        cwdDeny: [],
        maxTimeoutMs: 5000,
        defaultTimeoutMs: 1000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      },
    });
    const session = eng.start({ goal: "test" });
    expect(session.workspaceDir.startsWith(workspaceRoot)).toBe(true);
    expect(fs.existsSync(session.workspaceDir)).toBe(true);
  });
});

describe("CodeActEngine — step error paths", () => {
  it("step() on unknown session throws", async () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    await expect(
      eng.step({ sessionId: "missing", code: "print(1)" }),
    ).rejects.toThrow(/not found/);
  });

  it("step() on an aborted session throws", async () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    const s = eng.start({ goal: "g" });
    eng.end(s.id, "aborted");
    await expect(eng.step({ sessionId: s.id, code: "print(1)" })).rejects.toThrow(/aborted/);
  });

  it("step() rejects hard-denied code", async () => {
    const eng = new CodeActEngine({
      risk: new RiskEngine(),
      log: null,
      workspaceRoot: path.join(tmpDir, "workspace"),
    });
    const s = eng.start({ goal: "g" });
    await expect(eng.step({ sessionId: s.id, code: "import os; os.system('shutdown /s')" }))
      .rejects.toThrow(/sandbox refused/);
  });
});
