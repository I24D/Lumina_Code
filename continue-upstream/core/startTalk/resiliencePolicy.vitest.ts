import { describe, expect, it } from "vitest";

import {
  getStartTalkRetryDelayMs,
  LIVE_SESSION_ROTATION_MS,
} from "./resiliencePolicy.js";

describe("Start Talk resilience policy", () => {
  it("backs off retries without ever exceeding thirty seconds", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 20].map(getStartTalkRetryDelayMs),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("rotates the live session before the fifteen minute server limit", () => {
    expect(LIVE_SESSION_ROTATION_MS).toBe(12 * 60_000);
    expect(LIVE_SESSION_ROTATION_MS).toBeLessThan(15 * 60_000);
  });
});
