/**
 * AuditLog — append-only JSONL of every input action attempt.
 *
 * Every tool calls `record()` BEFORE acting (with the planned action)
 * and either no-ops (denied/needs_confirmation) or completes the action
 * and updates the same record via id. We choose JSONL append-only over
 * SQLite to keep the surface tiny and human-greppable. The user can
 * `tail -f` this file to see what Lumina is doing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuditRecord, InputActionKind, ActionDecision } from "./types.js";

const DEFAULT_PATH = join(homedir(), ".lumina", "input-control", "audit.jsonl");

function makeId(): string {
  return Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
}

export class AuditLog {
  private readonly file: string;
  private ready = false;

  constructor(filePath?: string) {
    this.file = filePath ?? DEFAULT_PATH;
  }

  record(input: {
    kind: InputActionKind;
    decision: ActionDecision;
    summary: string;
    ok: boolean;
    error?: string | null;
  }): AuditRecord {
    this.ensureDir();
    const rec: AuditRecord = {
      id: makeId(),
      atISO: new Date().toISOString(),
      kind: input.kind,
      decision: input.decision.kind,
      processName: input.decision.processName,
      summary: input.summary,
      ok: input.ok,
      error: input.error ?? null,
    };
    try {
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch {
      // Audit should never throw — the action proceeds regardless.
    }
    return rec;
  }

  filePath(): string {
    return this.file;
  }

  private ensureDir(): void {
    if (this.ready) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.ready = true;
    } catch {
      this.ready = true; // give up; record() will surface failure silently
    }
  }
}
