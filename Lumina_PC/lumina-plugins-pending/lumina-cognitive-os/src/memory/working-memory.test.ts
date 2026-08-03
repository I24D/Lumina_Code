/**
 * Tests for the Working Memory store (Nivel 2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkingMemoryStore } from "./working-memory.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-wm-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("WorkingMemoryStore", () => {
  it("starts empty", () => {
    const wm = new WorkingMemoryStore(tmpDir);
    expect(wm.get().currentProject).toBeNull();
    expect(wm.get().pinnedContext).toEqual([]);
  });

  it("persists set() across instances", () => {
    const wm = new WorkingMemoryStore(tmpDir);
    wm.set({ currentIntent: "investigate", currentProject: { name: "lumina", path: "c:/x" } });
    const wm2 = new WorkingMemoryStore(tmpDir);
    expect(wm2.get().currentIntent).toBe("investigate");
    expect(wm2.get().currentProject?.name).toBe("lumina");
  });

  it("caps pinnedContext at 5 entries via pin()", () => {
    const wm = new WorkingMemoryStore(tmpDir);
    for (let i = 0; i < 8; i++) wm.pin(`line-${i}`);
    expect(wm.get().pinnedContext.length).toBe(5);
    // Newest first.
    expect(wm.get().pinnedContext[0]).toBe("line-7");
  });

  it("unpin() removes a line", () => {
    const wm = new WorkingMemoryStore(tmpDir);
    wm.pin("a");
    wm.pin("b");
    wm.unpin("a");
    expect(wm.get().pinnedContext).toEqual(["b"]);
  });
});
