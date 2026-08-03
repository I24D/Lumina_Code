/**
 * Tests for RecorderStore + scrubbing.
 *
 * The recorder.py sidecar requires pynput/mss + a real desktop session;
 * those bits aren't testable from vitest. What we DO test is everything
 * the TS layer owns: disk layout, manifest parsing, pagination, scrubbing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecorderStore, generateSessionId, type RecordingEvent } from "./recorder-store.js";
import { redactSecretsInText, defaultScrubbingPolicy } from "./scrubbing.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-rec-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeSession(store: RecorderStore, sessionId: string, events: RecordingEvent[], extraMeta: Record<string, unknown> = {}): string {
  const dir = store.prepareNewSessionDir(sessionId);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      sessionId,
      version: "1.0.0-test",
      mode: "events",
      captureUia: true,
      fpsHintHz: 5,
      startedAtISO: "2026-06-28T09:00:00.000Z",
      stoppedAtISO: "2026-06-28T09:00:05.000Z",
      eventCount: events.length,
      platform: "win32",
      ...extraMeta,
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  for (const e of events) {
    if (typeof e.screenshot === "string") {
      const p = path.join(dir, e.screenshot);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "PNG", "utf8");
    }
  }
  return dir;
}

describe("generateSessionId", () => {
  it("creates an id with the prefix and a timestamp", () => {
    const id = generateSessionId();
    expect(id.startsWith("rec-")).toBe(true);
    expect(id.length).toBeGreaterThan(15);
  });
  it("does not collide on rapid calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSessionId()));
    expect(ids.size).toBeGreaterThan(40); // allow tiny chance of collision
  });
});

describe("RecorderStore — layout", () => {
  it("creates the root dir lazily", () => {
    const store = new RecorderStore(path.join(tmpDir, "fresh"));
    expect(fs.existsSync(store.rootDir)).toBe(true);
  });

  it("prepareNewSessionDir creates the screenshots subdir", () => {
    const store = new RecorderStore(tmpDir);
    const dir = store.prepareNewSessionDir("test-id");
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "screenshots"))).toBe(true);
  });
});

describe("RecorderStore — read", () => {
  it("readMeta returns null when missing", () => {
    const store = new RecorderStore(tmpDir);
    expect(store.readMeta("nope")).toBeNull();
  });

  it("summarize fills derived fields", () => {
    const store = new RecorderStore(tmpDir);
    writeSession(store, "test", [
      { idx: 1, atMs: 0, kind: "session.start", screenshot: "screenshots/000001.png" },
      { idx: 2, atMs: 120, kind: "mouse.down", pos: { x: 10, y: 20 }, button: "left", screenshot: "screenshots/000002.png" },
    ]);
    const sum = store.summarize("test")!;
    expect(sum.sessionId).toBe("test");
    expect(sum.eventCount).toBe(2);
    expect(sum.screenshotCount).toBe(2);
    expect(sum.mode).toBe("events");
    expect(sum.durationMs).toBe(5000);
  });

  it("list sorts by startedAtISO descending", () => {
    const store = new RecorderStore(tmpDir);
    writeSession(store, "older", [{ idx: 1, atMs: 0, kind: "x" }], { startedAtISO: "2026-06-26T09:00:00.000Z" });
    writeSession(store, "newer", [{ idx: 1, atMs: 0, kind: "x" }], { startedAtISO: "2026-06-28T09:00:00.000Z" });
    const list = store.list();
    expect(list.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });

  it("readEvents paginates", () => {
    const store = new RecorderStore(tmpDir);
    const evs: RecordingEvent[] = Array.from({ length: 10 }, (_, i) => ({
      idx: i + 1,
      atMs: i * 100,
      kind: "mouse.down",
      pos: { x: i, y: i },
      button: "left",
    }));
    writeSession(store, "p", evs);
    const slice = store.readEvents("p", { offset: 3, limit: 4 });
    expect(slice.map((e) => e.idx)).toEqual([4, 5, 6, 7]);
  });

  it("readEvents handles corrupt lines without throwing", () => {
    const store = new RecorderStore(tmpDir);
    const dir = store.prepareNewSessionDir("dirty");
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ sessionId: "dirty", version: "x", mode: "events", captureUia: false, fpsHintHz: 5, startedAtISO: new Date().toISOString(), platform: "win32" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      '{"idx":1,"atMs":0,"kind":"a"}\nBROKEN\n{"idx":2,"atMs":1,"kind":"b"}\n',
      "utf8",
    );
    const events = store.readEvents("dirty");
    expect(events.length).toBe(2);
    expect(events[0]!.kind).toBe("a");
    expect(events[1]!.kind).toBe("b");
  });
});

describe("RecorderStore — delete", () => {
  it("removes the session folder", () => {
    const store = new RecorderStore(tmpDir);
    writeSession(store, "die", [{ idx: 1, atMs: 0, kind: "x" }]);
    expect(fs.existsSync(store.sessionDir("die"))).toBe(true);
    expect(store.delete("die")).toBe(true);
    expect(fs.existsSync(store.sessionDir("die"))).toBe(false);
  });

  it("returns false for missing session", () => {
    const store = new RecorderStore(tmpDir);
    expect(store.delete("nope")).toBe(false);
  });
});

describe("RecorderStore — scrub", () => {
  it("redacts keys that look like secrets in events.jsonl", () => {
    const store = new RecorderStore(tmpDir);
    writeSession(store, "secret-session", [
      { idx: 1, atMs: 0, kind: "key.down", key: "a" },
      { idx: 2, atMs: 1, kind: "key.down", key: "user@example.com" },
      { idx: 3, atMs: 2, kind: "key.down", key: "sk-abc12345abc12345abc12345abc12345" },
      { idx: 4, atMs: 3, kind: "mouse.down", pos: { x: 1, y: 2 }, button: "left" },
    ]);
    const r = store.scrub("secret-session");
    expect(r.ok).toBe(true);
    expect(r.redactions).toBeGreaterThanOrEqual(2);
    const events = store.readEvents("secret-session");
    expect(events[0]!.key).toBe("a");
    expect(events[1]!.key).toMatch(/REDACTED:email/);
    expect(events[2]!.key).toMatch(/REDACTED:apikey/);
  });

  it("returns ok=false when events.jsonl missing", () => {
    const store = new RecorderStore(tmpDir);
    expect(store.scrub("missing").ok).toBe(false);
  });
});

describe("redactSecretsInText", () => {
  const p = defaultScrubbingPolicy();
  it("redacts emails", () => {
    expect(redactSecretsInText("hello dal@example.com", p)).toMatch(/REDACTED:email/);
  });
  it("redacts bearer tokens", () => {
    expect(redactSecretsInText("Bearer abcdefghijklmnopq1234", p)).toMatch(/REDACTED:bearer/);
  });
  it("redacts sk- api keys", () => {
    expect(redactSecretsInText("sk-abc12345abc12345abc12345abc12345", p)).toMatch(/REDACTED:apikey/);
  });
  it("leaves normal text alone", () => {
    expect(redactSecretsInText("hello world", p)).toBe("hello world");
  });
});
