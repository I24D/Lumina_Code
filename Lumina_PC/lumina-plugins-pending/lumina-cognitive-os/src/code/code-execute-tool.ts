/**
 * code-execute-tool.ts — Tool: lumina_code_execute
 *
 * Runs a snippet of Python / Bash / PowerShell / Node in a sandboxed
 * subprocess and returns stdout/stderr/exit-code. Integrated end-to-end:
 *
 *   1. preflightCheck()    — hard sandbox policy (cwd allowlist, denied
 *                            shutdown/format/rm-rf, language allowlist)
 *   2. RiskEngine.evaluate — tier classification (SAFE / WARNING /
 *                            HIGH_RISK / CRITICAL); tool result includes
 *                            the verdict so the calling agent can ask
 *                            the user for confirmation BEFORE re-calling
 *                            with confirm=true
 *   3. confirm gate        — HIGH_RISK requires confirm: true on the
 *                            call; CRITICAL is always refused at this
 *                            layer (the user must run it directly)
 *   4. runPythonSidecar    — code_executor.py subprocess
 *   5. ActionLog append    — every execution logged (success or refusal)
 *
 * This tool DOES NOT run untrusted code from the open internet. It runs
 * code your agent wrote on YOUR machine, with the same blast radius as
 * if you'd typed it in a terminal yourself.
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import { runPythonSidecar } from "../shared/python.js";
import type { RiskEngine } from "../risk/risk-engine.js";
import type { ActionLogStore } from "../memory/action-log.js";
import {
  defaultSandboxPolicy,
  languageToRiskAction,
  preflightCheck,
  SUPPORTED_LANGUAGES,
  type SandboxPolicy,
} from "./sandbox-policy.js";

type ExecutorResponse = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  killedByTimeout: boolean;
  language?: string;
  interpreter?: string;
  cwd?: string;
  error?: string | null;
};

export function createCodeExecuteTool(params: {
  risk: RiskEngine;
  log: ActionLogStore | null;
  policy?: SandboxPolicy;
  defaultCwd?: string;
}): AnyAgentTool {
  const policy = params.policy ?? defaultSandboxPolicy();
  const defaultCwd =
    params.defaultCwd ??
    process.env.LUMINA_CODE_DEFAULT_CWD ??
    process.env.USERPROFILE ??
    process.env.HOME ??
    "c:/I24D_WhatsApp";

  return {
    name: "lumina_code_execute",
    label: "Lumina Code — Execute",
    description:
      "Runs a Python / Bash / PowerShell / Node snippet on the user's machine in a subprocess sandbox " +
      "(cwd allowlist, timeout, output caps, hard denies for shutdown/format/rm-rf). Risk Engine classifies " +
      "the call: SAFE runs silently, WARNING runs with a note, HIGH_RISK requires `confirm: true` on the " +
      "next call, CRITICAL is refused at this layer. Use for one-shot tasks: calculations, file " +
      "conversions, JSON/CSV processing, scripted automation that's faster as code than as tool calls.",
    parameters: Type.Object({
      language: Type.Union(
        SUPPORTED_LANGUAGES.map((l) => Type.Literal(l)),
        { description: "Interpreter to use." },
      ),
      code: Type.String({
        minLength: 1,
        maxLength: 64_000,
        description: "Source code to execute. Will be passed via -c / -e / -Command (NOT through a shell).",
      }),
      cwd: Type.Optional(
        Type.String({
          maxLength: 1024,
          description: "Absolute working directory. Must be inside the cwd allowlist. Defaults to %USERPROFILE%.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ minimum: 100, maximum: policy.maxTimeoutMs, default: policy.defaultTimeoutMs }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Extra env vars merged on top of a minimal base (PATH, USERPROFILE, …).",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Set to true only on a SECOND call after the user explicitly confirmed a HIGH_RISK action.",
        }),
      ),
    }),
    async execute(_id, p) {
      const language = (p.language as string)?.trim().toLowerCase();
      const code = p.code?.trim();
      if (!language) throw new ToolInputError("language is required");
      if (!code) throw new ToolInputError("code is required");
      const cwd = (p.cwd?.trim() || defaultCwd).replace(/\\/g, "/");

      // 1) Sandbox preflight
      const verdict = preflightCheck({
        policy,
        language,
        cwd,
        code,
        timeoutMs: p.timeoutMs,
      });
      if (!verdict.ok) {
        params.log?.append({
          action: "code.execute.refused",
          target: `${language}:${cwd}`,
          result: "error",
          detail: verdict.reason,
          source: "code-executor",
        });
        return jsonResult({ ok: false, refused: "sandbox-policy", reason: verdict.reason });
      }

      // 2) Risk classification
      const riskAction = languageToRiskAction(language);
      const decision = params.risk.evaluate({
        category: "exec",
        action: `${riskAction}: ${code.slice(0, 120)}`,
        target: cwd,
      });

      if (decision.tier === "CRITICAL") {
        params.log?.append({
          action: "code.execute.refused",
          target: `${language}:${cwd}`,
          result: "error",
          detail: `CRITICAL: ${decision.reason}`,
          source: "code-executor",
          extra: { ruleId: decision.ruleId },
        });
        return jsonResult({
          ok: false,
          refused: "risk-critical",
          tier: decision.tier,
          reason: decision.reason,
          ruleId: decision.ruleId,
          hint: "CRITICAL actions cannot be confirmed inline. The user must run this directly.",
        });
      }

      if (decision.tier === "HIGH_RISK" && !p.confirm) {
        params.log?.append({
          action: "code.execute.pending",
          target: `${language}:${cwd}`,
          result: "warn",
          detail: `HIGH_RISK: ${decision.reason}`,
          source: "code-executor",
          extra: { ruleId: decision.ruleId },
        });
        return jsonResult({
          ok: false,
          refused: "needs-confirmation",
          tier: decision.tier,
          reason: decision.reason,
          ruleId: decision.ruleId,
          hint:
            "Show the user the code + risk reason and the exact cwd. If they say yes, re-call this " +
            "tool with the SAME code and confirm: true.",
          preview: { language, cwd, timeoutMs: verdict.timeoutMs, codeBytes: code.length },
        });
      }

      // 3) Execute via Python sidecar
      const request = JSON.stringify({
        language,
        code,
        cwd: verdict.cwd,
        timeoutMs: verdict.timeoutMs,
        maxStdoutBytes: policy.maxStdoutBytes,
        maxStderrBytes: policy.maxStderrBytes,
        env: p.env ?? {},
      });
      const sidecarResult = await runPythonSidecar("code_executor", [], {
        stdin: request,
        timeoutMs: verdict.timeoutMs + 5_000,
      });
      if (!sidecarResult.ok && sidecarResult.code !== 0 && !sidecarResult.stdout.trim()) {
        params.log?.append({
          action: "code.execute.sidecar-error",
          target: `${language}:${cwd}`,
          result: "error",
          detail: sidecarResult.error ?? `exit ${sidecarResult.code}`,
          source: "code-executor",
        });
        return jsonResult({
          ok: false,
          refused: "sidecar",
          reason: sidecarResult.error ?? `code_executor.py exited ${sidecarResult.code}`,
          stderr: sidecarResult.stderr,
        });
      }

      let parsed: ExecutorResponse;
      try {
        parsed = JSON.parse(sidecarResult.stdout.trim()) as ExecutorResponse;
      } catch (e) {
        params.log?.append({
          action: "code.execute.parse-error",
          target: `${language}:${cwd}`,
          result: "error",
          detail: (e as Error).message,
          source: "code-executor",
        });
        return jsonResult({
          ok: false,
          refused: "sidecar-output",
          reason: `failed to parse sidecar JSON: ${(e as Error).message}`,
          raw: sidecarResult.stdout.slice(0, 400),
        });
      }

      // 4) Log the run
      params.log?.append({
        action: "code.execute",
        target: `${language}:${cwd}`,
        result: parsed.ok ? "ok" : parsed.killedByTimeout ? "warn" : "error",
        detail: parsed.killedByTimeout
          ? `killed by timeout after ${parsed.durationMs}ms`
          : `exit ${parsed.code} in ${parsed.durationMs}ms`,
        source: "code-executor",
        extra: {
          tier: decision.tier,
          stdoutTruncated: parsed.stdoutTruncated,
          stderrTruncated: parsed.stderrTruncated,
          interpreter: parsed.interpreter,
        },
      });

      return jsonResult({
        ok: parsed.ok,
        tier: decision.tier,
        riskRule: decision.ruleId,
        exit: parsed.code,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        stdoutTruncated: parsed.stdoutTruncated,
        stderrTruncated: parsed.stderrTruncated,
        durationMs: parsed.durationMs,
        killedByTimeout: parsed.killedByTimeout,
        language: parsed.language,
        interpreter: parsed.interpreter,
        cwd: parsed.cwd,
      });
    },
  };
}
