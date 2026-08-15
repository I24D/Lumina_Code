import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_TEXT_LENGTH = 6_000;
const MAX_SESSION_FILES = 64;
const MAX_APPEND_BYTES = 2 * 1024 * 1024;

type SessionFileState = {
  eligible?: boolean;
  offset: number;
};

export interface CodexVoiceResponse {
  id: string;
  text: string;
}

export interface CodexVoiceMonitorOptions {
  onResponse: (response: CodexVoiceResponse) => void;
  pollIntervalMs?: number;
  sessionRoot?: string;
}

/** Extracts only a completed Codex answer, never commentary or tool traffic. */
export function parseCodexFinalResponse(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      payload?: {
        type?: unknown;
        phase?: unknown;
        message?: unknown;
      };
    };
    const payload = event.payload;
    if (
      event.type !== "event_msg" ||
      payload?.type !== "agent_message" ||
      payload.phase !== "final_answer" ||
      typeof payload.message !== "string"
    ) {
      return undefined;
    }
    const text = payload.message.trim().slice(0, MAX_TEXT_LENGTH);
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tails Codex VS Code JSONL sessions while Start Talk is active. Existing
 * answers are baselined instead of replayed, and `codex_exec`/subprocess
 * sessions are ignored so only the user's visible Codex chat is spoken.
 */
export class CodexVoiceMonitor {
  private readonly intervalMs: number;
  private readonly sessionRoot: string;
  private readonly states = new Map<string, SessionFileState>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;

  constructor(private readonly options: CodexVoiceMonitorOptions) {
    const codexHome = process.env.CODEX_HOME?.trim();
    this.sessionRoot =
      options.sessionRoot ??
      path.join(codexHome || path.join(os.homedir(), ".codex"), "sessions");
    this.intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.baselineExistingSessions();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private baselineExistingSessions(): void {
    for (const file of this.listSessionFiles()) {
      try {
        this.states.set(file, {
          eligible: this.readSessionEligibility(file),
          offset: fs.statSync(file).size,
        });
      } catch {
        // A session can rotate between discovery and stat; the next poll sees it.
      }
    }
  }

  private listSessionFiles(): string[] {
    if (!fs.existsSync(this.sessionRoot)) {
      return [];
    }

    const files: Array<{ file: string; modified: number }> = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 6) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            files.push({
              file: fullPath,
              modified: fs.statSync(fullPath).mtimeMs,
            });
          } catch {
            // File disappeared while scanning.
          }
        }
      }
    };
    visit(this.sessionRoot, 0);

    return files
      .sort((left, right) => right.modified - left.modified)
      .slice(0, MAX_SESSION_FILES)
      .map(({ file }) => file);
  }

  private readSessionEligibility(file: string): boolean | undefined {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(file, "r");
      const buffer = Buffer.alloc(64 * 1024);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const firstLine = buffer
        .subarray(0, count)
        .toString("utf8")
        .split("\n")[0];
      return this.parseSessionEligibility(firstLine);
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }

  private parseSessionEligibility(line: string): boolean | undefined {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        payload?: { originator?: unknown; source?: unknown; type?: unknown };
      };
      if (event.type !== "session_meta") {
        return undefined;
      }
      return (
        event.payload?.source === "vscode" ||
        event.payload?.originator === "codex_vscode"
      );
    } catch {
      return undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const file of this.listSessionFiles()) {
        if (this.stopped) {
          return;
        }
        await this.readAppendedLines(file);
      }
    } finally {
      this.polling = false;
    }
  }

  private async readAppendedLines(file: string): Promise<void> {
    let state = this.states.get(file);
    if (!state) {
      state = { offset: 0 };
      this.states.set(file, state);
    }

    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file, "r");
      const size = (await handle.stat()).size;
      if (size < state.offset) {
        state.offset = 0;
        state.eligible = undefined;
      }
      if (size === state.offset) {
        return;
      }

      const skippedPrefix = size - state.offset > MAX_APPEND_BYTES;
      const readFrom = skippedPrefix
        ? Math.max(0, size - MAX_APPEND_BYTES)
        : state.offset;
      const buffer = Buffer.alloc(size - readFrom);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        readFrom,
      );
      const bytes = buffer.subarray(0, bytesRead);
      const finalNewline = bytes.lastIndexOf(0x0a);
      if (finalNewline < 0) {
        return;
      }

      state.offset = readFrom + finalNewline + 1;
      const lines = bytes
        .subarray(0, finalNewline)
        .toString("utf8")
        .split("\n");
      if (skippedPrefix) {
        lines.shift();
      }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) {
          continue;
        }
        const eligibility = this.parseSessionEligibility(line);
        if (eligibility !== undefined) {
          state.eligible = eligibility;
          continue;
        }
        if (state.eligible !== true) {
          continue;
        }
        const text = parseCodexFinalResponse(line);
        if (text && !this.stopped) {
          this.options.onResponse({
            id: `codex:${path.basename(file)}:${readFrom}:${index}`,
            text,
          });
        }
      }
    } catch {
      // Session creation/rotation is racy by nature; retry on the next tick.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
