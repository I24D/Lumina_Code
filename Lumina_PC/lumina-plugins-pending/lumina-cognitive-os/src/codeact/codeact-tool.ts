/**
 * codeact-tool.ts — Agent tools for the CodeAct loop.
 *
 *   lumina_codeact_start   — open a session for a goal; returns a Python
 *                            preamble + the list of stubs available
 *   lumina_codeact_step    — execute ONE Python snippet under the
 *                            session's sandbox; returns observation,
 *                            stdout, stderr, and whether the session is
 *                            now done (final emitted)
 *   lumina_codeact_status  — inspect a session (steps so far, status)
 *   lumina_codeact_end     — close a session
 *
 * The host agent (Gemini Live, Claude, Codex) drives the loop:
 *   1. start() → reads preamble + goal
 *   2. generate Python that uses `lumina.*` helpers
 *   3. step(code) → reads stdout / observations
 *   4. decide: keep going, or stop because lumina.final(...) was emitted
 *   5. end() to close
 */
import { Type } from "typebox";
import {
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import type { CodeActEngine, CodeActSession } from "./codeact-loop.js";

const STUB_REFERENCE = [
  "lumina.health()                          # bridge health JSON",
  "lumina.processes()                       # list Windows processes",
  "lumina.window_list()                     # visible windows (title+pid+process)",
  "lumina.window_focus(title: str)          # bring matching window to front",
  "lumina.window_launch(application: str)   # launch a predefined app",
  "lumina.screen_capture()                  # PNG path on disk",
  "lumina.clipboard_get() -> str            # current clipboard text",
  "lumina.clipboard_set(text: str)          # replace clipboard text",
  "lumina.notify_toast(title, message)      # Windows toast",
  "lumina.camera_devices()                  # PnP cameras + status",
  "lumina.observation(value)                # emit a structured observation",
  "lumina.final(value)                      # FINAL answer; session ends",
];

function buildStartPreamble(session: CodeActSession): string {
  return [
    `You are operating Lumina in CodeAct mode for the goal:`,
    `  ${session.goal}`,
    ``,
    `Each turn, write a SHORT Python snippet that uses the lumina_py_stubs`,
    `module (auto-imported as \`lumina\`). The snippet runs in a sandbox`,
    `(timeout, cwd allowlist, hard denies for shutdown/format/rm-rf). You`,
    `can ONLY use the helpers listed below — they're a deliberately`,
    `READ-MOSTLY subset:`,
    ``,
    ...STUB_REFERENCE.map((l) => `    ${l}`),
    ``,
    `Print observations with \`lumina.observation(...)\` so future turns can`,
    `see them. When you have the final answer, call \`lumina.final({"answer": ...})\`.`,
    `That terminates the session.`,
    ``,
    `Conventions:`,
    `  - Keep snippets under 60 lines.`,
    `  - Catch and print errors inline (don't let exceptions bubble — you`,
    `    won't get them back if the process exits non-zero).`,
    `  - Don't import anything beyond stdlib + \`lumina\`.`,
    `  - You have ${session.maxIterations} iterations max.`,
    `  - Workspace dir (your cwd): ${session.workspaceDir}`,
  ].join("\n");
}

function publicSession(session: CodeActSession): Record<string, unknown> {
  return {
    id: session.id,
    goal: session.goal,
    status: session.status,
    workspaceDir: session.workspaceDir,
    createdAtISO: session.createdAtISO,
    maxIterations: session.maxIterations,
    stepsTaken: session.steps.length,
    final: session.steps.length > 0 ? session.steps[session.steps.length - 1]!.final : undefined,
  };
}

export function createCodeActStartTool(engine: CodeActEngine): AnyAgentTool {
  return {
    name: "lumina_codeact_start",
    label: "Lumina CodeAct — Start",
    description:
      "Opens a CodeAct session for a multi-step goal. Returns a Python preamble + the list of " +
      "`lumina.*` helpers available + the workspace cwd. After this, call lumina_codeact_step " +
      "with the Python you want to run for the first iteration. The session ends when your code " +
      "emits `lumina.final(...)` or you call lumina_codeact_end.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 4, maxLength: 1000 }),
      maxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 6 })),
      sessionId: Type.Optional(
        Type.String({ maxLength: 64, description: "Optional fixed session id; otherwise auto-generated." }),
      ),
    }),
    async execute(_id, p) {
      try {
        const session = engine.start({ goal: p.goal, maxIterations: p.maxIterations, sessionId: p.sessionId });
        return jsonResult({
          ok: true,
          session: publicSession(session),
          preamble: buildStartPreamble(session),
          helpers: STUB_REFERENCE,
        });
      } catch (e) {
        throw new ToolInputError((e as Error).message);
      }
    },
  };
}

export function createCodeActStepTool(engine: CodeActEngine): AnyAgentTool {
  return {
    name: "lumina_codeact_step",
    label: "Lumina CodeAct — Step",
    description:
      "Executes one Python snippet inside a CodeAct session. Returns stdout/stderr/exit, plus any " +
      "`lumina.observation(...)` payloads and a `final` value if `lumina.final(...)` was called. " +
      "If `done` is true, stop iterating.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 64 }),
      code: Type.String({ minLength: 1, maxLength: 32_000 }),
      timeoutMs: Type.Optional(Type.Number({ minimum: 500, maximum: 120_000, default: 30_000 })),
    }),
    async execute(_id, p) {
      try {
        const { session, step } = await engine.step({
          sessionId: p.sessionId,
          code: p.code,
          timeoutMs: p.timeoutMs,
        });
        return jsonResult({
          ok: step.exit === 0 && !step.killedByTimeout,
          done: session.status !== "open",
          status: session.status,
          step: {
            index: step.index,
            exit: step.exit,
            durationMs: step.durationMs,
            stdout: step.stdout,
            stderr: step.stderr,
            stdoutTruncated: step.stdoutTruncated,
            stderrTruncated: step.stderrTruncated,
            killedByTimeout: step.killedByTimeout,
            observations: step.observations,
            final: step.final,
          },
          session: publicSession(session),
        });
      } catch (e) {
        return jsonResult({ ok: false, error: (e as Error).message });
      }
    },
  };
}

export function createCodeActStatusTool(engine: CodeActEngine): AnyAgentTool {
  return {
    name: "lumina_codeact_status",
    label: "Lumina CodeAct — Status",
    description: "Inspect a CodeAct session: status, iterations taken, last final value (if any).",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    async execute(_id, p) {
      const session = engine.get(p.sessionId);
      if (!session) {
        return jsonResult({ ok: false, error: `session '${p.sessionId}' not found` });
      }
      return jsonResult({
        ok: true,
        session: publicSession(session),
        steps: session.steps.map((s) => ({
          index: s.index,
          atISO: s.atISO,
          exit: s.exit,
          durationMs: s.durationMs,
          codeBytes: s.codeBytes,
          observationCount: s.observations.length,
          hasFinal: s.final !== undefined,
        })),
      });
    },
  };
}

export function createCodeActEndTool(engine: CodeActEngine): AnyAgentTool {
  return {
    name: "lumina_codeact_end",
    label: "Lumina CodeAct — End",
    description: "Closes a CodeAct session. Use after lumina.final() fired or to abort manually.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 64 }),
      status: Type.Optional(
        Type.Union([Type.Literal("done"), Type.Literal("aborted")], { default: "aborted" }),
      ),
    }),
    async execute(_id, p) {
      const session = engine.end(p.sessionId, (p.status as "done" | "aborted") ?? "aborted");
      if (!session) {
        return jsonResult({ ok: false, error: `session '${p.sessionId}' not found` });
      }
      return jsonResult({ ok: true, session: publicSession(session) });
    },
  };
}
