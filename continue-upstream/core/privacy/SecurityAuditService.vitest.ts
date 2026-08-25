import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecurityAuditService } from "./SecurityAuditService.js";

const folders: string[] = [];

function service() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-audit-"));
  folders.push(folder);
  return {
    file: path.join(folder, "audit.jsonl"),
    audit: new SecurityAuditService(
      path.join(folder, "audit.jsonl"),
      () => new Date("2026-08-25T12:00:00.000Z"),
    ),
  };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("SecurityAuditService", () => {
  it("persists newest-first events and filters by category", () => {
    const { audit } = service();
    audit.record({
      category: "permissions",
      action: "changed",
      actor: "user",
      outcome: "changed",
      summary: "Microphone changed to block",
    });
    audit.record({
      category: "tools",
      action: "approved",
      actor: "user",
      outcome: "allowed",
      summary: "Approved terminal",
    });

    expect(audit.list().events.map((event) => event.category)).toEqual([
      "tools",
      "permissions",
    ]);
    expect(audit.list({ category: "tools" }).total).toBe(1);
  });

  it("redacts values and omits secret-shaped detail fields", () => {
    const { audit, file } = service();
    const token = `ghp_${"a".repeat(30)}`;
    const event = audit.record({
      category: "secrets",
      action: "configuration",
      actor: "system",
      outcome: "succeeded",
      summary: `Loaded ${token}`,
      details: { apiKey: token, endpoint: `token=${token}` },
    });

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(event.details?.apiKey).toBe("[omitted]");
    expect(event.redactions.length).toBeGreaterThan(0);
  });

  it("clears the durable trail", () => {
    const { audit } = service();
    audit.record({
      category: "system",
      action: "startup",
      actor: "system",
      outcome: "succeeded",
      summary: "Started",
    });
    expect(audit.clear()).toBe(1);
    expect(audit.list().events).toEqual([]);
  });
});
