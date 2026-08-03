/**
 * Claude Code CLI adapter.
 *
 * Spawneamos el binario `claude` con `-p "<prompt>"` y leemos stdout en
 * streaming (acumulado para devolver al final). Honra AbortSignal para
 * cancelación por voz.
 *
 * Notas:
 *   - El CLI `claude` debe estar instalado (`npm i -g @anthropic-ai/claude-code`
 *     o el binario que use el usuario). Si no está en PATH, el usuario pasa
 *     `binPath` por config.
 *   - Pasamos `cwd: process.cwd()` (la carpeta del gateway) para que
 *     referencias a archivos relativos funcionen. Si el caller quiere otra,
 *     hay que extender la API.
 *   - Timeout y AbortController son obligatorios — sin ellos, un prompt
 *     pesado puede colgar la sesión del usuario.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AdapterCapabilities, ClaudeAdapter, ClaudeTarget } from "../types.js";

const CODE_CAPS: AdapterCapabilities = {
  streaming: true,
  toolUse: true,
  vision: false,
  fileAttach: true,
  structuredOutput: true,
};

export type ClaudeCodeCliAdapterOptions = {
  readonly binPath?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
};

export class ClaudeCodeCliAdapter implements ClaudeAdapter {
  readonly target: ClaudeTarget = "code-cli";
  readonly capabilities: AdapterCapabilities = CODE_CAPS;

  constructor(private readonly opts: ClaudeCodeCliAdapterOptions = {}) {}

  async available(): Promise<boolean> {
    const bin = this.resolveBinary();
    return bin !== null;
  }

  async send(
    payload: string,
    attachments: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<{ response: string; meta?: Record<string, unknown> }> {
    const bin = this.resolveBinary();
    if (bin === null) {
      throw new Error("claude CLI not found in PATH or config.binPath");
    }
    const timeoutMs = this.opts.timeoutMs ?? 300_000;
    const cwd = this.opts.cwd ?? dirname(bin);

    // Built-in `claude -p "<prompt>"` runs the prompt non-interactively.
    // For attachments we pass them as additional args (CLI supports
    // `-f file1 -f file2`). Caller is responsible for resolving abs paths.
    const args: string[] = ["-p", payload];
    for (const att of attachments) {
      args.push("-f", att);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* noop */ }
        reject(new Error(`claude CLI timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        try { child.kill("SIGTERM"); } catch { /* noop */ }
        clearTimeout(timer);
        reject(new Error("claude CLI aborted by signal"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve({
          response: stdout.trim(),
          meta: { exitCode: code, bin, stderrBytes: stderr.length },
        });
      });
    });
  }

  // ─── internals ───────────────────────────────────────────────

  private resolveBinary(): string | null {
    if (this.opts.binPath && existsSync(this.opts.binPath)) {
      return this.opts.binPath;
    }
    // Try common paths.
    const candidates = [
      "claude",
      "claude.exe",
      "claude.cmd",
      // Windows global npm
      `${process.env.APPDATA ?? ""}\\npm\\claude.cmd`,
      // POSIX global npm
      "/usr/local/bin/claude",
    ];
    for (const c of candidates) {
      if (c && existsSync(c)) return c;
    }
    // Last resort: assume it's in PATH and let spawn find it.
    return "claude";
  }
}
