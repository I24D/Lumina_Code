import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkboardService } from "./WorkboardService.js";

const roots: string[] = [];

function service() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-workboard-"));
  roots.push(root);
  let timestamp = Date.parse("2026-08-25T12:00:00.000Z");
  return {
    root,
    board: new WorkboardService({
      storagePath: path.join(root, "board.json"),
      now: () => new Date(timestamp++),
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkboardService", () => {
  it("persists cards, moves and activity", () => {
    const { root, board } = service();
    const card = board.create({
      title: "  Repair Start Talk  ",
      priority: "critical",
      tags: ["Voice", "voice", "UI"],
      sessionId: "session-1",
    });
    board.update(card.id, { column: "review" });

    const restored = new WorkboardService({
      storagePath: path.join(root, "board.json"),
    }).snapshot();

    expect(restored.cards[0]).toMatchObject({
      title: "Repair Start Talk",
      priority: "critical",
      column: "review",
      tags: ["voice", "ui"],
      sessionId: "session-1",
    });
    expect(restored.counts.review).toBe(1);
    expect(restored.activity.map((entry) => entry.kind)).toEqual([
      "moved",
      "created",
    ]);
  });

  it("tracks completion and removal without resurrecting a card", () => {
    const { board } = service();
    const card = board.create({ title: "Ship release", column: "ready" });
    const done = board.update(card.id, { column: "done" });
    expect(done.completedAt).toBeDefined();

    board.remove(card.id);
    const snapshot = board.snapshot();
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.activity[0]).toMatchObject({
      kind: "deleted",
      cardId: card.id,
    });
  });

  it("rejects invalid and empty updates", () => {
    const { board } = service();
    expect(() => board.create({ title: "   " })).toThrow(/título/i);
    const card = board.create({ title: "Valid" });
    expect(() => board.update(card.id, { title: "" })).toThrow(/título/i);
    expect(() => board.update("missing", { title: "No" })).toThrow(
      /no existe/i,
    );
  });
});
