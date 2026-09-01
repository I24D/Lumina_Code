import { describe, expect, it } from "vitest";

import { TurnCancellationManager } from "./TurnCancellationManager.js";

describe("TurnCancellationManager", () => {
  it("aborts every operation from the interrupted turn", () => {
    const manager = new TurnCancellationManager();
    const search = manager.startOperation();
    const memory = manager.startOperation();

    manager.cancel("barge-in");

    expect(search.signal.aborted).toBe(true);
    expect(memory.signal.aborted).toBe(true);
    expect(search.isCurrent()).toBe(false);
    expect(manager.activeOperations()).toBe(0);
    expect(manager.reason()).toBe("barge-in");
  });

  it("rejects a late result even when its implementation ignored abort", () => {
    const manager = new TurnCancellationManager();
    const old = manager.startOperation();
    manager.beginTurn();
    const current = manager.startOperation();

    expect(old.generation).not.toBe(current.generation);
    expect(old.isCurrent()).toBe(false);
    expect(current.isCurrent()).toBe(true);

    current.finish();
    expect(current.isCurrent()).toBe(false);
  });
});
