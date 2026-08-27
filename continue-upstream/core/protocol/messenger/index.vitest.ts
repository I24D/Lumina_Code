import { describe, expect, it } from "vitest";

import { messageExpectsResponse } from "./index.js";

describe("webview message response policy", () => {
  it("mantiene respuestas para requests y streams", () => {
    expect(messageExpectsResponse({})).toBe(true);
    expect(messageExpectsResponse({ fireAndForget: false })).toBe(true);
  });

  it("suprime respuestas para eventos unidireccionales", () => {
    expect(messageExpectsResponse({ fireAndForget: true })).toBe(false);
  });
});
