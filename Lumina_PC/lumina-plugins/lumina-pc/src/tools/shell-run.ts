/**
 * shell-run.ts
 * Tool: lumina_shell_run
 *
 * Executes a PowerShell or CMD command on the local PC on behalf of I24D.
 * Commands run with the same privileges as the OpenClaw process.
 *
 * Security: controlled via config.shellApprovalRequired.
 * When enabled (default), the user must approve via the OpenClaw approval system
 * before execution — this is handled by the OpenClaw exec-approval mechanism at
 * the agent level. Here we enforce a blocklist of obviously destructive patterns.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { capTerminalText, TERMINAL_CAPTURE_CHAR_LIMIT } from "../utils/tool-output-budget.js";
import { bridgePost, isWindowsBridgeMode } from "../utils/windows-bridge.js";

const execFileAsync = promisify(execFile);

// Patterns that require extra caution — blocked by default.
const DANGEROUS_PATTERNS = [
  /format\s+[a-z]:/i,
  /rm\s+(-rf?|\/s)\s+[a-z]:\\/i,
  /del\s+\/[fsq]/i,
  /rmdir\s+\/s/i,
  /diskpart/i,
  /bcdedit/i,
];

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

export type ShellRunConfig = {
  shellApprovalRequired: boolean;
};

export function createShellRunTool(config: ShellRunConfig): AnyAgentTool {
  return {
    name: "lumina_shell_run",
    description:
      "Executes a PowerShell command on the local Windows PC and returns stdout, stderr and exit code. " +
      "Use for reading system state, querying WMI, managing files, controlling services, etc. " +
      "Requires explicit user approval when shellApprovalRequired is true (default). " +
      "Always prefer read-only commands unless the user explicitly asks for changes.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "The PowerShell command or script block to execute. Example: Get-Process | Select-Object Name, CPU | Sort-Object CPU -Descending | Select-Object -First 10",
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Execution timeout in milliseconds. Default: 30000 (30 s). Max: 120000.",
          minimum: 1000,
          maximum: 120_000,
        }),
      ),
      shell: Type.Optional(
        Type.Union([Type.Literal("powershell"), Type.Literal("cmd")], {
          description: "Shell to use. Default: powershell.",
        }),
      ),
    }),
    // ownerOnly: true ensures only the owner can call this tool
    ownerOnly: true,
    async execute(_toolCallId: string, params) {
      if (isWindowsBridgeMode()) {
        const command = (params.command ?? "").trim();
        if (!command) {
          throw new ToolInputError("command is required.");
        }
        if ((params.shell ?? "powershell") !== "powershell") {
          return jsonResult({
            ok: false,
            error: "Windows Bridge dev mode only supports safe PowerShell commands.",
            stdout: "",
            stderr: "",
            exit_code: -1,
            shell: params.shell ?? "cmd",
            command,
          });
        }
        if (isDangerous(command)) {
          throw new ToolInputError(
            "Command matches a potentially destructive pattern. " +
              "Rephrase or use a safer equivalent and confirm intent explicitly.",
          );
        }
        const response = await bridgePost("/execute_powershell_safe", {
          command,
          timeout_ms: Math.min(params.timeout_ms ?? 30_000, 120_000),
        });
        return jsonResult({
          ok: response.ok === true,
          stdout: capTerminalText(String(response.stdout ?? "")).trim(),
          stderr: "",
          exit_code: response.ok === true ? 0 : -1,
          error: response.ok === true ? undefined : response.error,
          blocked: response.blocked,
          requiresConfirmation: response.requiresConfirmation,
          shell: "powershell",
          command,
          via: "lumina-windows-bridge",
        });
      }

      if (process.platform !== "win32") {
        return jsonResult({
          ok: false,
          error: "lumina_shell_run is only available on Windows.",
          stdout: "",
          stderr: "",
          exit_code: -1,
        });
      }

      const command = (params.command ?? "").trim();
      if (!command) {
        throw new ToolInputError("command is required.");
      }

      if (isDangerous(command)) {
        throw new ToolInputError(
          "Command matches a potentially destructive pattern. " +
            "Rephrase or use a safer equivalent and confirm intent explicitly.",
        );
      }

      const timeoutMs = Math.min(params.timeout_ms ?? 30_000, 120_000);
      const useShell = params.shell ?? "powershell";

      const [exe, args] =
        useShell === "cmd"
          ? ["cmd.exe", ["/d", "/s", "/c", command]]
          : [
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            ];

      try {
        const { stdout, stderr } = await execFileAsync(exe, args, {
          timeout: timeoutMs,
          encoding: "utf8",
          maxBuffer: TERMINAL_CAPTURE_CHAR_LIMIT * 16,
          windowsHide: true,
        });
        return jsonResult({
          ok: true,
          stdout: capTerminalText(stdout).trim(),
          stderr: capTerminalText(stderr).trim(),
          exit_code: 0,
          shell: useShell,
          command,
        });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };
        return jsonResult({
          ok: false,
          stdout: capTerminalText(e.stdout ?? "").trim(),
          stderr: capTerminalText(e.stderr ?? "").trim(),
          exit_code: typeof e.code === "number" ? e.code : -1,
          error: e.message,
          shell: useShell,
          command,
        });
      }
    },
  };
}
