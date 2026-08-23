import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createChildSession,
  listChildSessions,
  loadChildSession,
  saveChildSession,
} from "./childSession.js";

describe("child sessions", () => {
  it("persists and queries a child session by its parent", () => {
    const parentSessionId = randomUUID();
    const child = createChildSession(
      parentSessionId,
      "explore",
      "Inspect the permission system",
    );

    expect(child).toMatchObject({
      parentSessionId,
      agentName: "explore",
      status: "queued",
    });
    expect(loadChildSession(child.sessionId)).toMatchObject({
      sessionId: child.sessionId,
      parentSessionId,
    });

    child.status = "completed";
    child.history.push({
      message: { role: "assistant", content: "Inspection complete" },
      contextItems: [],
    });
    saveChildSession(child);

    expect(listChildSessions(parentSessionId)).toEqual([
      expect.objectContaining({
        sessionId: child.sessionId,
        status: "completed",
      }),
    ]);
  });

  it("does not mix children from different parent sessions", () => {
    const firstParent = randomUUID();
    const secondParent = randomUUID();
    const firstChild = createChildSession(firstParent, "explore", "First");
    createChildSession(secondParent, "review", "Second");

    expect(
      listChildSessions(firstParent).map((item) => item.sessionId),
    ).toEqual([firstChild.sessionId]);
  });

  it("rejects path traversal when loading a child session", () => {
    expect(loadChildSession("../outside")).toBeNull();
  });
});
