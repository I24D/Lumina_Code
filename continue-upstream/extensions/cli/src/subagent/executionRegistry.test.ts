import { describe, expect, it } from "vitest";

import {
  cancelChildExecution,
  isChildExecutionActive,
  registerChildExecution,
} from "./executionRegistry.js";

describe("child execution registry", () => {
  it("cancels only the requested active child", () => {
    const first = new AbortController();
    const second = new AbortController();
    const unregisterFirst = registerChildExecution("first", first);
    const unregisterSecond = registerChildExecution("second", second);

    expect(cancelChildExecution("first")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(cancelChildExecution("missing")).toBe(false);

    unregisterFirst();
    unregisterSecond();
    expect(isChildExecutionActive("first")).toBe(false);
    expect(isChildExecutionActive("second")).toBe(false);
  });
});
