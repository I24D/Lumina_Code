/**
 * recorder-store.ts — Disk layout + read helpers for recorded sessions.
 *
 * The recorder.py sidecar writes events directly. This module only:
 *   - manages the recordings root directory
 *   - generates a fresh sessionId + folder layout
 *   - reads back manifests / event slices for the tools
 *   - applies the optional scrubbing pass (PII redaction)
 *
 * On-disk layout per session:
 *
 *   <recordingsDir>/<sessionId>/
 *   ├── meta.json
 *   ├── events.jsonl
 *   ├── screenshots/000001.png ...
 *   └── uia/000001.json ...
 *
 * The sidecar owns ALL writes during a session. This file only writes
 * post-stop (when scrubbing runs).
 */
import fs from "node:fs";
import path from "node:path";
import { getLuminaEnvVar } from "../env.js";
import { redactSecretsInText, type ScrubbingPolicy, defaultScrubbingPolicy } from "./scrubbing.js";

export type RecorderMode = "events" | "screencast";

export type RecordingEventWindow = {
  readonly title: string;
  readonly pid: number | null;
  readonly className: string;
};

export type RecordingEvent = {
  readonly idx: number;
  readonly atMs: number;
  readonly kind: string;
  readonly screenshot?: string | null;
  readonly uia?: string | null;
  readonly window?: RecordingEventWindow | null;
  readonly pos?: { x: number; y: number };
  readonly button?: string;
  readonly key?: string;
  readonly dx?: number;
  readonly dy?: number;
  readonly label?: string;
};

export type RecordingMeta = {
  readonly sessionId: string;
  readonly version: string;
  readonly mode: RecorderMode;
  readonly captureUia: boolean;
  readonly fpsHintHz: number;
  readonly startedAtISO: string;
  readonly stoppedAtISO?: string;
  readonly eventCount?: number;
  readonly platform: string;
  readonly python?: string;
  readonly label?: string;
};

export type RecordingSummary = {
  readonly sessionId: string;
  readonly dir: string;
  readonly mode: RecorderMode;
  readonly startedAtISO: string;
  readonly stoppedAtISO: string | null;
  readonly eventCount: number;
  readonly screenshotCount: number;
  readonly uiaSnapshotCount: number;
  readonly durationMs: number | null;
  readonly label: string | null;
  readonly sizeBytes: number;
};

const DEFAULT_RECORDINGS_DIR = "c:/I24D_WhatsApp/recordings";

export function resolveRecordingsDir(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const env = getLuminaEnvVar("LUMINA_RECORDINGS_DIR");
  if (env && env.trim()) return path.resolve(env.trim());
  return path.resolve(DEFAULT_RECORDINGS_DIR);
}

export function generateSessionId(prefix = "rec"): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const rand = Math.floor(Math.random() * 0xffff).toString(36).padStart(4, "0");
  return `${prefix}-${stamp}-${rand}`;
}

export class RecorderStore {
  readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = resolveRecordingsDir(rootDir);
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
    } catch {
      /* lazy */
    }
  }

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, sessionId);
  }

  prepareNewSessionDir(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    return dir;
  }

  readMeta(sessionId: string): RecordingMeta | null {
    const file = path.join(this.sessionDir(sessionId), "meta.json");
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as RecordingMeta;
    } catch {
      return null;
    }
  }

  list(): RecordingSummary[] {
    if (!fs.existsSync(this.rootDir)) return [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: RecordingSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = this.summarize(entry.name);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => b.startedAtISO.localeCompare(a.startedAtISO));
  }

  summarize(sessionId: string): RecordingSummary | null {
    const dir = this.sessionDir(sessionId);
    const meta = this.readMeta(sessionId);
    if (!meta) return null;
    const screenshotsDir = path.join(dir, "screenshots");
    const uiaDir = path.join(dir, "uia");
    const screenshotCount = safeCount(screenshotsDir);
    const uiaSnapshotCount = safeCount(uiaDir);
    const eventCount = meta.eventCount ?? this.countEventLines(sessionId);
    const startedMs = Date.parse(meta.startedAtISO);
    const stoppedMs = meta.stoppedAtISO ? Date.parse(meta.stoppedAtISO) : NaN;
    return {
      sessionId,
      dir,
      mode: meta.mode,
      startedAtISO: meta.startedAtISO,
      stoppedAtISO: meta.stoppedAtISO ?? null,
      eventCount,
      screenshotCount,
      uiaSnapshotCount,
      durationMs: Number.isFinite(startedMs) && Number.isFinite(stoppedMs) ? stoppedMs - startedMs : null,
      label: meta.label ?? null,
      sizeBytes: dirSizeShallow(dir),
    };
  }

  countEventLines(sessionId: string): number {
    const file = path.join(this.sessionDir(sessionId), "events.jsonl");
    if (!fs.existsSync(file)) return 0;
    try {
      const raw = fs.readFileSync(file, "utf8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  readEvents(sessionId: string, opts: { offset?: number; limit?: number } = {}): RecordingEvent[] {
    const file = path.join(this.sessionDir(sessionId), "events.jsonl");
    if (!fs.existsSync(file)) return [];
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(5_000, opts.limit ?? 500);
    const out: RecordingEvent[] = [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n");
    let kept = 0;
    let skipped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      try {
        out.push(JSON.parse(line) as RecordingEvent);
        kept++;
      } catch {
        /* skip corrupt line */
      }
      if (kept >= limit) break;
    }
    return out;
  }

  delete(sessionId: string): boolean {
    const dir = this.sessionDir(sessionId);
    if (!fs.existsSync(dir)) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply scrubbing to the events.jsonl IN PLACE: redacts key sequences
   * that look like secrets in the recorded key.* events. Best-effort —
   * never throws, returns the count of redactions.
   */
  scrub(sessionId: string, policy: ScrubbingPolicy = defaultScrubbingPolicy()): { ok: boolean; redactions: number; error?: string } {
    const file = path.join(this.sessionDir(sessionId), "events.jsonl");
    if (!fs.existsSync(file)) return { ok: false, redactions: 0, error: "events.jsonl missing" };
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      return { ok: false, redactions: 0, error: (e as Error).message };
    }
    const lines = raw.split("\n");
    let redactions = 0;
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      try {
        const evt = JSON.parse(line) as Record<string, unknown>;
        if (typeof evt.key === "string") {
          const before = evt.key;
          const after = redactSecretsInText(before, policy);
          if (after !== before) {
            evt.key = after;
            redactions++;
          }
        }
        out.push(JSON.stringify(evt));
      } catch {
        out.push(line);
      }
    }
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, out.join("\n"), "utf8");
      fs.renameSync(tmp, file);
      return { ok: true, redactions };
    } catch (e) {
      return { ok: false, redactions, error: (e as Error).message };
    }
  }
}

function safeCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function dirSizeShallow(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  let visits = 0;
  while (stack.length > 0 && visits < 50_000) {
    const cur = stack.pop()!;
    visits++;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) total += stat.size;
        else if (stat.isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}
