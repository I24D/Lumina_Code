import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TODO_CONTENT_CHARS,
  MAX_TODO_ITEMS,
  TodoStore,
} from "./TodoStore";

let store: TodoStore;

beforeEach(() => {
  store = new TodoStore();
});

function item(id: string, status = "pending", content = `do ${id}`) {
  return { id, content, status };
}

describe("TodoStore", () => {
  it("starts empty", () => {
    expect(store.read()).toEqual({
      items: [],
      counts: { pending: 0, in_progress: 0, completed: 0, cancelled: 0 },
    });
  });

  it("keeps the order it was given, because order is priority", () => {
    store.write([item("c"), item("a"), item("b")]);
    expect(store.read().items.map((entry) => entry.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("counts each status", () => {
    store.write([
      item("a", "completed"),
      item("b", "in_progress"),
      item("c", "pending"),
      item("d", "cancelled"),
    ]);
    expect(store.read().counts).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1,
    });
  });

  describe("write modes", () => {
    it("replaces the whole list by default", () => {
      store.write([item("a"), item("b")]);
      store.write([item("c")]);

      // Dropping an item is a decision the model made; merging by default
      // would quietly keep work it had abandoned.
      expect(store.read().items.map((entry) => entry.id)).toEqual(["c"]);
    });

    it("merges by id and appends what is new", () => {
      store.write([item("a"), item("b")]);
      store.write([item("a", "completed"), item("c")], "merge");

      const items = store.read().items;
      expect(items.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      expect(items[0].status).toBe("completed");
    });

    it("merges in place rather than moving the updated item", () => {
      store.write([item("a"), item("b"), item("c")]);
      store.write([item("b", "completed")], "merge");

      // Reordering on update would shuffle the user's list under them.
      expect(store.read().items.map((entry) => entry.id)).toEqual([
        "a",
        "b",
        "c",
      ]);
    });
  });

  describe("rejecting entries instead of repairing them", () => {
    it.each([
      { description: "no id", raw: { content: "x", status: "pending" } },
      { description: "blank id", raw: { id: "  ", content: "x", status: "pending" } },
      { description: "no content", raw: { id: "a", status: "pending" } },
      { description: "an unknown status", raw: { id: "a", content: "x", status: "later" } },
      { description: "not an object", raw: "just a string" },
    ])("rejects an entry with $description", ({ raw }) => {
      const { snapshot, rejected } = store.write([raw]);

      // Silently coercing would leave the model planning against a list that
      // does not behave the way it thinks it does.
      expect(snapshot.items).toEqual([]);
      expect(rejected).toHaveLength(1);
    });

    it("keeps the valid entries alongside the rejected ones", () => {
      const { snapshot, rejected } = store.write([
        item("good"),
        { id: "bad", content: "x", status: "nonsense" },
      ]);

      expect(snapshot.items.map((entry) => entry.id)).toEqual(["good"]);
      expect(rejected).toHaveLength(1);
    });

    it("rejects a duplicate id rather than letting it shadow the first", () => {
      const { snapshot, rejected } = store.write([
        item("a", "pending"),
        item("a", "completed"),
      ]);

      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].status).toBe("pending");
      expect(rejected[0]).toMatch(/duplicate/u);
    });

    it("refuses a payload that is not an array", () => {
      expect(() => store.write({ id: "a" } as unknown)).toThrow(/array/u);
    });
  });

  describe("bounds", () => {
    it("truncates an over-long item instead of dropping it", () => {
      const { snapshot } = store.write([
        item("a", "pending", "x".repeat(MAX_TODO_CONTENT_CHARS + 500)),
      ]);
      expect(snapshot.items[0].content).toHaveLength(MAX_TODO_CONTENT_CHARS);
    });

    it("caps the list length", () => {
      const many = Array.from({ length: MAX_TODO_ITEMS + 10 }, (_, index) =>
        item(`item-${index}`),
      );
      expect(store.write(many).snapshot.items).toHaveLength(MAX_TODO_ITEMS);
    });
  });

  describe("session scoping", () => {
    it("clears the list when the conversation changes", () => {
      store.setActiveSession("session-1");
      store.write([item("a")]);
      store.setActiveSession("session-2");

      // A plan only means something against the messages that produced it.
      expect(store.read().items).toEqual([]);
    });

    it("keeps the list when the same session is set again", () => {
      store.setActiveSession("session-1");
      store.write([item("a")]);
      store.setActiveSession("session-1");

      // history/save fires constantly during a turn; re-announcing the same
      // session must not wipe the work.
      expect(store.read().items).toHaveLength(1);
    });
  });

  describe("surviving compaction", () => {
    it("returns nothing when there is no outstanding work", () => {
      store.write([item("a", "completed"), item("b", "cancelled")]);
      expect(store.formatForCompaction()).toBeUndefined();
    });

    it("carries only the outstanding items", () => {
      store.write([
        item("a", "completed", "already done"),
        item("b", "in_progress", "currently doing"),
        item("c", "pending", "still to do"),
      ]);

      const text = store.formatForCompaction()!;
      expect(text).toContain("currently doing");
      expect(text).toContain("still to do");
      // The summary already covers finished work; repeating it wastes the
      // context the compaction was meant to reclaim.
      expect(text).not.toContain("already done");
    });

    it("labels what was in progress so the model resumes the right item", () => {
      store.write([item("b", "in_progress", "currently doing")]);
      expect(store.formatForCompaction()).toMatch(/in progress/u);
    });
  });
});
