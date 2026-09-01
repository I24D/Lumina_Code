import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

export interface ClaudeCodeCliPrompt {
  /** Persona and rules. Passed as a file so accents and quotes survive argv. */
  system: string;
  /** The incoming message. Piped over stdin so it never lands in argv. */
  user: string;
}

export interface ClaudeCodeCliOptions {
  /** How long to wait before killing the CLI. Defaults to 90s. */
  timeoutMs?: number;
  /** Overrides CLI discovery. Mainly for tests. */
  cliPath?: string;
  logger?: (message: string) => void;
}

/**
 * Runs the Claude Code CLI headlessly for a single turn of text.
 *
 * This lived inside `Core` next to the WhatsApp auto-responder, which meant
 * core knew about npm layouts, nvm directories and stdin plumbing. It is its
 * own class so the responder can be tested against a stub, and so swapping the
 * drafting backend never touches `Core`.
 */
export class ClaudeCodeCliClient {
  private readonly timeoutMs: number;
  private readonly cliPath?: string;
  private readonly logger: (message: string) => void;

  constructor(options: ClaudeCodeCliOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.cliPath = options.cliPath;
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  /** Locates the Claude Code CLI (claude.cmd) so the responder can invoke it. */
  resolveCliPath(): string {
    if (this.cliPath) {
      return this.cliPath;
    }
    const explicit = process.env.LUMINA_CLAUDE_CLI?.trim();
    if (explicit) {
      return explicit;
    }
    const appdata = process.env.APPDATA;
    if (appdata) {
      const npmCmd = joinPath(appdata, "npm", "claude.cmd");
      if (existsSync(npmCmd)) {
        return npmCmd;
      }
    }
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const nvmRoot = joinPath(local, "nvm");
      try {
        const found = readdirSync(nvmRoot)
          .map((version) => joinPath(nvmRoot, version, "claude.cmd"))
          .filter((candidate) => existsSync(candidate))
          .sort();
        if (found.length > 0) {
          return found[found.length - 1];
        }
      } catch {
        // nvm not present; fall through to PATH.
      }
    }
    return "claude"; // rely on PATH
  }

  /**
   * Drafts a reply in one turn. Returns the text, or null on any failure — the
   * caller audits the outcome, so a thrown error here would only be noise.
   */
  generateReply(prompt: ClaudeCodeCliPrompt): Promise<string | null> {
    return new Promise((resolve) => {
      const cli = this.resolveCliPath();
      const sysFile = joinPath(tmpdir(), "lumina-whatsapp-persona.txt");
      try {
        writeFileSync(sysFile, prompt.system, "utf8");
      } catch {
        resolve(null);
        return;
      }
      let child;
      try {
        child = spawn(
          cli,
          [
            "-p",
            "--append-system-prompt-file",
            sysFile,
            "--output-format",
            "text",
            "--max-turns",
            "1",
          ],
          {
            cwd: tmpdir(), // neutral cwd: don't load this repo's CLAUDE.md/context
            windowsHide: true,
            shell: true,
            env: process.env,
          },
        );
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve(null);
      }, this.timeoutMs);
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        err += chunk.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(out.trim() || null);
        } else {
          this.logger(
            `[whatsapp-autoreply] claude exited ${code}: ${err.slice(0, 200)}`,
          );
          resolve(null);
        }
      });
      try {
        child.stdin?.write(prompt.user);
        child.stdin?.end();
      } catch {
        // stdin closed early; the close handler resolves.
      }
    });
  }
}
