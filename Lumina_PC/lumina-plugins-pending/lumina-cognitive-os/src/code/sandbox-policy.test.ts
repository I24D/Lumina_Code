/**
 * Tests for the code-execute sandbox policy.
 */
import { describe, expect, it } from "vitest";
import {
  defaultSandboxPolicy,
  languageToRiskAction,
  preflightCheck,
  SUPPORTED_LANGUAGES,
} from "./sandbox-policy.js";

const POLICY = defaultSandboxPolicy({
  cwdAllow: ["c:/work", "/tmp"],
  cwdDeny: ["c:/Windows", "/etc"],
});

describe("preflightCheck — language", () => {
  it("accepts every supported language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const v = preflightCheck({
        policy: POLICY,
        language: lang,
        cwd: "c:/work",
        code: "print(1)",
      });
      expect(v.ok).toBe(true);
    }
  });

  it("rejects unsupported language", () => {
    const v = preflightCheck({
      policy: POLICY,
      language: "ruby",
      cwd: "c:/work",
      code: "puts 1",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/not supported/);
  });
});

describe("preflightCheck — cwd", () => {
  it("rejects relative cwd", () => {
    const v = preflightCheck({ policy: POLICY, language: "python", cwd: "./relative", code: "print(1)" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/absolute/);
  });

  it("rejects cwd inside deny list", () => {
    const v = preflightCheck({ policy: POLICY, language: "python", cwd: "c:/Windows/System32", code: "print(1)" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/denied directory/);
  });

  it("rejects cwd outside the allow list", () => {
    const v = preflightCheck({ policy: POLICY, language: "python", cwd: "c:/random", code: "print(1)" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/allowlist/);
  });

  it("accepts cwd inside an allowed root", () => {
    const v = preflightCheck({ policy: POLICY, language: "python", cwd: "c:/work/sub/dir", code: "print(1)" });
    expect(v.ok).toBe(true);
  });
});

describe("preflightCheck — hard deny patterns", () => {
  const cases: Array<[string, string]> = [
    ["bash",       "rm -rf /home"],
    ["powershell", "Remove-Item -Recurse -Force C:\\Users\\dal\\important"],
    ["bash",       "shutdown -h now"],
    ["powershell", "Stop-Computer"],
    ["bash",       "format C:"],
    ["powershell", "Format-Volume -DriveLetter C"],
    ["powershell", "reg delete HKLM\\Software\\Microsoft\\Windows"],
    ["bash",       "diskpart < script.txt"],
    ["powershell", "bcdedit /set {default} bootstatuspolicy ignoreallfailures"],
  ];
  for (const [lang, code] of cases) {
    it(`rejects ${code.slice(0, 40)}…`, () => {
      const v = preflightCheck({ policy: POLICY, language: lang, cwd: "c:/work", code });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/hard-denied/);
    });
  }
});

describe("preflightCheck — timeout clamping", () => {
  it("clamps requested timeout to maxTimeoutMs", () => {
    const v = preflightCheck({
      policy: POLICY,
      language: "python",
      cwd: "c:/work",
      code: "print(1)",
      timeoutMs: 999_999,
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.timeoutMs).toBe(POLICY.maxTimeoutMs);
  });

  it("clamps requested timeout to a minimum", () => {
    const v = preflightCheck({
      policy: POLICY,
      language: "python",
      cwd: "c:/work",
      code: "print(1)",
      timeoutMs: 0,
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.timeoutMs).toBeGreaterThanOrEqual(100);
  });

  it("uses default when timeoutMs omitted", () => {
    const v = preflightCheck({
      policy: POLICY,
      language: "python",
      cwd: "c:/work",
      code: "print(1)",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.timeoutMs).toBe(POLICY.defaultTimeoutMs);
  });
});

describe("preflightCheck — empty code", () => {
  it("rejects empty code", () => {
    const v = preflightCheck({ policy: POLICY, language: "python", cwd: "c:/work", code: "   " });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/empty/);
  });
});

describe("languageToRiskAction", () => {
  it("maps python to python_exec", () => {
    expect(languageToRiskAction("python")).toBe("python_exec");
    expect(languageToRiskAction("python3")).toBe("python_exec");
  });
  it("maps powershell variants", () => {
    expect(languageToRiskAction("powershell")).toBe("powershell_exec");
    expect(languageToRiskAction("pwsh")).toBe("powershell_exec");
  });
  it("maps node and bash", () => {
    expect(languageToRiskAction("node")).toBe("node_exec");
    expect(languageToRiskAction("bash")).toBe("bash_exec");
  });
});
