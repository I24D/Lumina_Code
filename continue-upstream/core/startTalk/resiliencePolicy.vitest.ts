import { describe, expect, it } from "vitest";

import {
  classifyVoiceFailure,
  getStartTalkRetryDelayMs,
  getVoiceReconnectDecision,
  LIVE_SESSION_ROTATION_MS,
  MAX_START_TALK_RECONNECT_ATTEMPTS,
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

  it("does not reconnect forever on bad credentials or a bad model", () => {
    expect(classifyVoiceFailure("401 invalid API key")).toBe("authentication");
    expect(getVoiceReconnectDecision("invalid model", 1).retry).toBe(false);
    expect(
      getVoiceReconnectDecision(
        "socket closed",
        MAX_START_TALK_RECONNECT_ATTEMPTS + 1,
      ),
    ).toMatchObject({ retry: false, fallbackRecommended: true });
  });

  it("marks quota and rate limits as provider-fallback candidates", () => {
    expect(getVoiceReconnectDecision("quota exhausted", 1)).toMatchObject({
      kind: "quota",
      retry: true,
      fallbackRecommended: true,
    });
    expect(getVoiceReconnectDecision("429 too many requests", 2)).toMatchObject({
      kind: "rate-limit",
      delayMs: 2_000,
    });
  });
});
