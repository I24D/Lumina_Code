import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  getContinueGlobalPath,
  setConfigFilePermissions,
} from "../util/paths.js";
import { redactSecrets } from "../util/redactSecrets.js";

export type SecurityAuditCategory =
  | "permissions"
  | "tools"
  | "channels"
  | "secrets"
  | "system";
export type SecurityAuditActor = "user" | "agent" | "system";
export type SecurityAuditOutcome =
  | "allowed"
  | "blocked"
  | "rejected"
  | "succeeded"
  | "failed"
  | "changed";

export type SecurityAuditDetail = string | number | boolean;

export interface SecurityAuditInput {
  category: SecurityAuditCategory;
  action: string;
  actor: SecurityAuditActor;
  outcome: SecurityAuditOutcome;
  summary: string;
  details?: Record<string, SecurityAuditDetail>;
}

export interface SecurityAuditEvent extends SecurityAuditInput {
  id: string;
  timestamp: string;
  redactions: string[];
}

export interface SecurityAuditQuery {
  category?: SecurityAuditCategory;
  limit?: number;
}

export interface SecurityAuditSnapshot {
  events: SecurityAuditEvent[];
  total: number;
  storage: "local";
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RETAIN_EVENTS = 500;
const SENSITIVE_KEY =
  /api.?key|authorization|credential|password|secret|token/iu;

function sanitizeText(
  value: string,
  maxLength: number,
): {
  text: string;
  rules: string[];
} {
  const redacted = redactSecrets(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ""),
  );
  return { text: redacted.text.slice(0, maxLength), rules: redacted.rules };
}

function sanitizeDetails(
  details: Record<string, SecurityAuditDetail> | undefined,
): { details?: Record<string, SecurityAuditDetail>; rules: string[] } {
  if (!details) return { rules: [] };
  const safe: Record<string, SecurityAuditDetail> = {};
  const rules = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(details).slice(0, 20)) {
    const key = rawKey.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 60);
    if (!key) continue;
    if (SENSITIVE_KEY.test(key)) {
      safe[key] = "[omitted]";
      rules.add("sensitive-field");
      continue;
    }
    if (typeof rawValue === "string") {
      const value = sanitizeText(rawValue, 500);
      safe[key] = value.text;
      value.rules.forEach((rule) => rules.add(rule));
    } else {
      safe[key] = rawValue;
    }
  }
  return { details: safe, rules: [...rules] };
}

function isAuditEvent(value: unknown): value is SecurityAuditEvent {
  const event = value as Partial<SecurityAuditEvent> | undefined;
  return Boolean(
    event &&
      typeof event.id === "string" &&
      typeof event.timestamp === "string" &&
      typeof event.category === "string" &&
      typeof event.action === "string" &&
      typeof event.summary === "string",
  );
}

/**
 * Append-only local security trail. Inputs are redacted and size-bounded before
 * touching disk; secret-shaped detail fields are omitted even if a caller
 * accidentally supplies one.
 */
export class SecurityAuditService {
  constructor(
    private readonly filePath = path.join(
      getContinueGlobalPath(),
      "lumina-security-audit.jsonl",
    ),
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: SecurityAuditInput): SecurityAuditEvent {
    const summary = sanitizeText(input.summary, 1_000);
    const action = sanitizeText(input.action, 80);
    const details = sanitizeDetails(input.details);
    const event: SecurityAuditEvent = {
      id: randomUUID(),
      timestamp: this.now().toISOString(),
      category: input.category,
      action: action.text || "event",
      actor: input.actor,
      outcome: input.outcome,
      summary: summary.text || "Security event",
      ...(details.details ? { details: details.details } : {}),
      redactions: [
        ...new Set([...summary.rules, ...action.rules, ...details.rules]),
      ],
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      setConfigFilePermissions(this.filePath);
      this.rotateIfNeeded();
    } catch {
      // Security logging must never make the protected operation crash.
    }
    return event;
  }

  list(query: SecurityAuditQuery = {}): SecurityAuditSnapshot {
    const all = this.readAll();
    const filtered = query.category
      ? all.filter((event) => event.category === query.category)
      : all;
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    return {
      events: filtered.slice(-limit).reverse(),
      total: filtered.length,
      storage: "local",
    };
  }

  clear(): number {
    const removed = this.readAll().length;
    this.replace([]);
    return removed;
  }

  private readAll(): SecurityAuditEvent[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return fs
        .readFileSync(this.filePath, "utf8")
        .split(/\r?\n/gu)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return isAuditEvent(value) ? [value] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(): void {
    if (fs.statSync(this.filePath).size <= MAX_FILE_BYTES) return;
    this.replace(this.readAll().slice(-RETAIN_EVENTS));
  }

  private replace(events: SecurityAuditEvent[]): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      const body = events.length
        ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "";
      fs.writeFileSync(temporary, body, "utf8");
      fs.renameSync(temporary, this.filePath);
      setConfigFilePermissions(this.filePath);
    } catch {
      // Best effort for the same reason as record().
    }
  }
}
