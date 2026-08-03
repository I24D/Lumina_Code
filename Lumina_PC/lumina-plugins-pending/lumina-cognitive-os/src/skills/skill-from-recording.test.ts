/**
 * Tests for the Demo → Skill generator.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecorderStore, type RecordingEvent } from "../recorder/recorder-store.js";
import { buildSkillFromRecording } from "./skill-from-recording.js";
import { SkillLoader } from "./skill-loader.js";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-skill-from-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedRecording(store: RecorderStore, id: string, events: RecordingEvent[]): void {
  const dir = store.prepareNewSessionDir(id);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      sessionId: id,
      version: "test",
      mode: "events",
      captureUia: true,
      fpsHintHz: 5,
      startedAtISO: "2026-06-28T09:00:00.000Z",
      stoppedAtISO: "2026-06-28T09:00:05.000Z",
      eventCount: events.length,
      platform: "win32",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

describe("buildSkillFromRecording", () => {
  it("creates a complete skill folder under skills/", () => {
    const recordingsRoot = path.join(tmpRoot, "recordings");
    const skillsRoot = path.join(tmpRoot, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    const recorder = new RecorderStore(recordingsRoot);
    seedRecording(recorder, "rec-sample", [
      { idx: 1, atMs: 0, kind: "session.start", window: { title: "Notepad", pid: 1, className: "" } },
      { idx: 2, atMs: 100, kind: "mouse.down", pos: { x: 50, y: 60 }, button: "left", window: { title: "Notepad", pid: 1, className: "" } },
      { idx: 3, atMs: 200, kind: "key.down", key: "h", window: { title: "Notepad", pid: 1, className: "" } },
    ]);
    const r = buildSkillFromRecording(recorder, {
      sessionId: "rec-sample",
      skillName: "Open Notepad",
      skillsDir: skillsRoot,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skillId).toBe("learned-open-notepad");
    expect(fs.existsSync(r.skillFile)).toBe(true);
    expect(fs.existsSync(path.join(r.skillDir, "references", "demo-summary.md"))).toBe(true);
    expect(fs.existsSync(path.join(r.skillDir, "scripts", "replay.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.skillDir, "recording", "source.json"))).toBe(true);
    const replayJson = JSON.parse(fs.readFileSync(path.join(r.skillDir, "scripts", "replay.json"), "utf8"));
    expect(replayJson.sessionId).toBe("rec-sample");
  });

  it("the generated SKILL.md is loadable by the SkillLoader", () => {
    const recordingsRoot = path.join(tmpRoot, "recordings");
    const skillsRoot = path.join(tmpRoot, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    const recorder = new RecorderStore(recordingsRoot);
    seedRecording(recorder, "rec-loadable", [
      { idx: 1, atMs: 0, kind: "mouse.down", pos: { x: 1, y: 2 }, button: "left" },
    ]);
    const r = buildSkillFromRecording(recorder, {
      sessionId: "rec-loadable",
      skillName: "test-skill",
      skillsDir: skillsRoot,
    });
    expect(r.ok).toBe(true);

    const loader = new SkillLoader({ skillsDir: skillsRoot });
    const list = loader.list();
    expect(list.find((s) => s.id === "learned-test-skill")).toBeTruthy();
    const skill = loader.get("learned-test-skill");
    expect(skill).toBeTruthy();
    expect(skill?.metadata.lumina).toBeTruthy();
  });

  it("rejects when recording does not exist", () => {
    const recorder = new RecorderStore(path.join(tmpRoot, "recordings"));
    const r = buildSkillFromRecording(recorder, {
      sessionId: "missing",
      skillName: "x",
      skillsDir: tmpRoot,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  it("rejects when skill already exists", () => {
    const recordingsRoot = path.join(tmpRoot, "recordings");
    const skillsRoot = path.join(tmpRoot, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    const recorder = new RecorderStore(recordingsRoot);
    seedRecording(recorder, "dup", [{ idx: 1, atMs: 0, kind: "session.start" }]);

    const a = buildSkillFromRecording(recorder, {
      sessionId: "dup",
      skillName: "dup-test",
      skillsDir: skillsRoot,
    });
    expect(a.ok).toBe(true);
    const b = buildSkillFromRecording(recorder, {
      sessionId: "dup",
      skillName: "dup-test",
      skillsDir: skillsRoot,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatch(/already exists/);
  });

  it("normalizes weird skillName to kebab-case", () => {
    const recordingsRoot = path.join(tmpRoot, "recordings");
    const skillsRoot = path.join(tmpRoot, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    const recorder = new RecorderStore(recordingsRoot);
    seedRecording(recorder, "norm", [{ idx: 1, atMs: 0, kind: "session.start" }]);

    const r = buildSkillFromRecording(recorder, {
      sessionId: "norm",
      skillName: "  Organize   My-Downloads!! ",
      skillsDir: skillsRoot,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skillId).toBe("learned-organize-my-downloads");
  });
});
