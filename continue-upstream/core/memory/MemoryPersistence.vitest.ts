import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryService } from "./MemoryService.js";
import {
  MemoryPersistence,
  emptyMemorySnapshot,
  mergeMemorySnapshots,
} from "./MemoryPersistence.js";
import type { ExperienceRecord } from "./types.js";

const roots: string[] = [];

function experience(id: string, createdAt: string): ExperienceRecord {
  return {
    id,
    goal: `Goal ${id}`,
    summary: `Summary ${id}`,
    outcome: "success",
    toolNames: ["read_file"],
    tags: ["test"],
    createdAt,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("MemoryPersistence", () => {
  it("persists reflections and skill candidates, not only experiences", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-memory-"));
    roots.push(root);
    const storage = new MemoryPersistence(path.join(root, "memory.json"));
    const memory = new MemoryService();
    memory.logExperience({
      goal: "First failure",
      summary: "The build failed",
      outcome: "failure",
      toolNames: ["run_terminal_command"],
      tags: ["critical"],
    });
    memory.logExperience({
      goal: "Second failure",
      summary: "The build failed again",
      outcome: "failure",
      toolNames: ["run_terminal_command"],
      tags: ["critical"],
    });
    storage.save(memory.snapshot());

    const restored = new MemoryService();
    restored.replace(storage.load());
    expect(restored.experienceLogger.count()).toBe(2);
    expect(restored.getInsights().length).toBeGreaterThan(0);
    expect(restored.getSkillCandidates().length).toBeGreaterThan(0);
  });

  it("imports valid records from the legacy JSONL file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-memory-"));
    roots.push(root);
    const legacy = path.join(root, "experiences.jsonl");
    fs.writeFileSync(
      legacy,
      `${JSON.stringify(experience("legacy", "2026-08-20T00:00:00.000Z"))}\ninvalid\n`,
    );
    const storage = new MemoryPersistence(
      path.join(root, "memory.json"),
      legacy,
    );
    expect(storage.load().experiences.map((record) => record.id)).toEqual([
      "legacy",
    ]);
  });

  it("merges devices and honors the newest deletion tombstone", () => {
    const local = {
      ...emptyMemorySnapshot(),
      experiences: [
        experience("local", "2026-08-20T00:00:00.000Z"),
        experience("deleted", "2026-08-20T00:00:00.000Z"),
      ],
    };
    const remote = {
      ...emptyMemorySnapshot(),
      experiences: [experience("remote", "2026-08-21T00:00:00.000Z")],
      tombstones: [{ id: "deleted", deletedAt: "2026-08-22T00:00:00.000Z" }],
    };

    const merged = mergeMemorySnapshots(local, remote);
    expect(merged.experiences.map((record) => record.id).sort()).toEqual([
      "local",
      "remote",
    ]);
    expect(merged.tombstones).toEqual(remote.tombstones);
  });
});
