/**
 * codeact-loop.ts — CodeAct session state + step executor.
 *
 * CodeAct pattern (inspired by OpenJarvis native_openhands):
 *
 *   The LLM writes Python that calls `lumina_py_stubs` helpers instead
 *   of JSON tool calls. Each Python turn is one step:
 *
 *       import lumina_py_stubs as lumina
 *       windows = lumina.window_list()["windows"]
 *       chrome = [w for w in windows if "chrome" in w["title"].lower()]
 *       if chrome:
 *           lumina.observation({"found": chrome[0]})
 *       else:
 *           lumina.window_launch("chrome")
 *           lumina.observation({"launched": True})
 *
 *   The loop runs that Python under the Fase-2 sandbox (with cwd =
 *   per-session workspace, PYTHONPATH = sidecars dir), captures stdout
 *   + stderr, scans for `CODEACT_FINAL:` to detect termination, and
 *   appends an observation to the session so the next LLM turn sees it.
 *
 * The tool layer (`codeact-tool.ts`) is intentionally SPLIT into
 * `start`, `step`, `end` so the host agent does the LLM calls itself
 * (Gemini Live, Claude, Codex, …). This keeps every approval semantic
 * intact and works inside Start Talk without extra plumbing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RiskEngine } from "../risk/risk-engine.js";
import type { ActionLogStore } from "../memory/action-log.js";
import { runPythonSidecar } from "../shared/python.js";
import {
  defaultSandboxPolicy,
  preflightCheck,
  type SandboxPolicy,
} from "../code/sandbox-policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = path.resolve(here, "../../sidecars");
const FINAL_PREFIX = "CODEACT_FINAL:";
const OBS_PREFIX = "CODEACT_OBSERVATION:";

export type CodeActStep = {
  readonly index: number;
  readonly atISO: string;
  readonly codeBytes: number;
  readonly exit: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly killedByTimeout: boolean;
  readonly final: unknown | undefined;
  readonly observations: ReadonlyArray<unknown>;
};

export type CodeActSession = {
  readonly id: string;
  readonly goal: string;
  readonly workspaceDir: string;
  readonly createdAtISO: string;
  readonly maxIterations: number;
  status: "open" | "done" | "aborted" | "timeout";
  readonly steps: CodeActStep[];
};

export type CodeActOptions = {
  readonly risk: RiskEngine;
  readonly log: ActionLogStore | null;
  readonly policy?: SandboxPolicy;
  readonly workspaceRoot?: string;
  readonly bridgeUrl?: string;
};

const DEFAULT_MAX_ITERATIONS = 6;

export class CodeActEngine {
  private readonly risk: RiskEngine;
  private readonly log: ActionLogStore | null;
  private readonly policy: SandboxPolicy;
  private readonly workspaceRoot: string;
  private readonly bridgeUrl: string;
  private sessions = new Map<string, CodeActSession>();

  constructor(opts: CodeActOptions) {
    this.risk = opts.risk;
    this.log = opts.log;
    this.workspaceRoot = path.resolve(
      opts.workspaceRoot ?? "c:/I24D_WhatsApp/codeact-workspace",
    );
    this.bridgeUrl = opts.bridgeUrl ?? process.env.LUMINA_BRIDGE_URL ?? "http://127.0.0.1:8765";
    // The CodeAct workspace and the sidecar root are always allowed,
    // regardless of the user's cwdAllow customisations.
    const base = opts.policy ?? defaultSandboxPolicy();
    this.policy = {
      ...base,
      cwdAllow: dedupe([...base.cwdAllow, this.workspaceRoot, SIDECAR_ROOT]),
    };
    try {
      fs.mkdirSync(this.workspaceRoot, { recursive: true });
    } catch {
      /* ignore — first step will retry */
    }
  }

  start(params: { goal: string; maxIterations?: number; sessionId?: string }): CodeActSession {
    const goal = (params.goal ?? "").trim();
    if (!goal) {
      throw new Error("goal is required");
    }
    const id = params.sessionId?.trim() || newSessionId();
    if (this.sessions.has(id)) {
      throw new Error(`CodeAct session '${id}' already exists`);
    }
    const workspaceDir = path.join(this.workspaceRoot, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const session: CodeActSession = {
      id,
      goal,
      workspaceDir,
      createdAtISO: new Date().toISOString(),
      maxIterations: Math.max(1, Math.min(20, params.maxIterations ?? DEFAULT_MAX_ITERATIONS)),
      status: "open",
      steps: [],
    };
    this.sessions.set(id, session);
    this.log?.append({
      action: "codeact.start",
      target: `session:${id}`,
      result: "ok",
      detail: goal.slice(0, 160),
      source: "codeact-engine",
      extra: { workspaceDir, maxIterations: session.maxIterations },
    });
    return session;
  }

  get(id: string): CodeActSession | null {
    return this.sessions.get(id) ?? null;
  }

  list(): ReadonlyArray<CodeActSession> {
    return Array.from(this.sessions.values()).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO));
  }

  end(id: string, status: "done" | "aborted" = "aborted"): CodeActSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.status = status;
    this.log?.append({
      action: "codeact.end",
      target: `session:${id}`,
      result: status === "done" ? "ok" : "warn",
      detail: `iterations=${session.steps.length}`,
      source: "codeact-engine",
    });
    return session;
  }

  async step(params: {
    sessionId: string;
    code: string;
    timeoutMs?: number;
  }): Promise<{ session: CodeActSession; step: CodeActStep }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`CodeAct session '${params.sessionId}' not found`);
    if (session.status !== "open") {
      throw new Error(`CodeAct session '${session.id}' is ${session.status}; cannot step further`);
    }
    if (session.steps.length >= session.maxIterations) {
      session.status = "timeout";
      throw new Error(
        `CodeAct session '${session.id}' has reached maxIterations=${session.maxIterations}; call end() and start a new one`,
      );
    }
    const code = (params.code ?? "").trim();
    if (!code) throw new Error("code is required");

    const verdict = preflightCheck({
      policy: this.policy,
      language: "python",
      cwd: session.workspaceDir,
      code,
      timeoutMs: params.timeoutMs,
    });
    if (!verdict.ok) {
      this.log?.append({
        action: "codeact.step.refused",
        target: `session:${session.id}`,
        result: "error",
        detail: verdict.reason,
        source: "codeact-engine",
      });
      throw new Error(`sandbox refused: ${verdict.reason}`);
    }

    const decision = this.risk.evaluate({
      category: "exec",
      action: `codeact_python: ${code.slice(0, 120)}`,
      target: session.workspaceDir,
    });
    if (decision.tier === "CRITICAL") {
      this.log?.append({
        action: "codeact.step.refused",
        target: `session:${session.id}`,
        result: "error",
        detail: `CRITICAL: ${decision.reason}`,
        source: "codeact-engine",
      });
      throw new Error(`risk CRITICAL: ${decision.reason}`);
    }

    const request = JSON.stringify({
      language: "python",
      code: prependCodeActImport(code),
      cwd: session.workspaceDir,
      timeoutMs: verdict.timeoutMs,
      maxStdoutBytes: this.policy.maxStdoutBytes,
      maxStderrBytes: this.policy.maxStderrBytes,
      env: {
        LUMINA_BRIDGE_URL: this.bridgeUrl,
        PYTHONPATH: SIDECAR_ROOT,
      },
    });
    const sidecarResult = await runPythonSidecar("code_executor", [], {
      stdin: request,
      timeoutMs: verdict.timeoutMs + 5_000,
    });
    if (!sidecarResult.ok && !sidecarResult.stdout.trim()) {
      throw new Error(`code_executor sidecar failed: ${sidecarResult.error ?? sidecarResult.stderr}`);
    }
    let parsed: {
      ok: boolean; code: number; stdout: string; stderr: string;
      stdoutTruncated: boolean; stderrTruncated: boolean;
      durationMs: number; killedByTimeout: boolean;
    };
    try {
      parsed = JSON.parse(sidecarResult.stdout.trim());
    } catch (e) {
      throw new Error(`code_executor returned non-JSON: ${(e as Error).message}`);
    }
    const { finalValue, observations } = scanStdout(parsed.stdout);
    const step: CodeActStep = {
      index: session.steps.length + 1,
      atISO: new Date().toISOString(),
      codeBytes: code.length,
      exit: parsed.code,
      durationMs: parsed.durationMs,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      stdoutTruncated: parsed.stdoutTruncated,
      stderrTruncated: parsed.stderrTruncated,
      killedByTimeout: parsed.killedByTimeout,
      final: finalValue,
      observations,
    };
    session.steps.push(step);
    if (finalValue !== undefined) {
      session.status = "done";
    } else if (session.steps.length >= session.maxIterations) {
      session.status = "timeout";
    }
    this.log?.append({
      action: "codeact.step",
      target: `session:${session.id}#${step.index}`,
      result: step.killedByTimeout ? "warn" : step.exit === 0 ? "ok" : "error",
      detail: finalValue !== undefined
        ? `FINAL emitted`
        : `exit ${step.exit} in ${step.durationMs}ms`,
      source: "codeact-engine",
      extra: { observations: observations.length },
    });
    return { session, step };
  }
}

let SESSION_ID_COUNTER = 0;
function newSessionId(): string {
  SESSION_ID_COUNTER = (SESSION_ID_COUNTER + 1) & 0xffffff;
  const tick = Math.floor(performance.now()).toString(36);
  const counter = SESSION_ID_COUNTER.toString(36).padStart(4, "0");
  return `ca-${process.pid}-${tick}-${counter}`;
}

function dedupe(arr: ReadonlyArray<string>): string[] {
  return Array.from(new Set(arr));
}

const CODEACT_HEADER = "# Auto-prepended by Lumina CodeAct\nimport lumina_py_stubs as lumina  # noqa: F401\n";

function prependCodeActImport(code: string): string {
  if (/(^|\n)\s*import\s+lumina_py_stubs/.test(code)) return code;
  return CODEACT_HEADER + code;
}

function scanStdout(stdout: string): { finalValue: unknown | undefined; observations: unknown[] } {
  const observations: unknown[] = [];
  let finalValue: unknown | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(FINAL_PREFIX)) {
      const payload = line.slice(FINAL_PREFIX.length);
      try { finalValue = JSON.parse(payload); } catch { finalValue = payload; }
      continue;
    }
    if (line.startsWith(OBS_PREFIX)) {
      const payload = line.slice(OBS_PREFIX.length);
      try { observations.push(JSON.parse(payload)); } catch { observations.push(payload); }
    }
  }
  return { finalValue, observations };
}
