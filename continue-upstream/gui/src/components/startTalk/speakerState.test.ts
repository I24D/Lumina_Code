import { describe, expect, it } from "vitest";

import { resolveSpeakerUpdate } from "./speakerState";

describe("resolveSpeakerUpdate", () => {
  it("keeps an explicit non-match so a previous identity is cleared", () => {
    const update = resolveSpeakerUpdate(2, {
      type: "speaker",
      sessionId: "session",
      turnId: 3,
      matched: false,
    });

    expect(update).toEqual({
      latestTurnId: 3,
      speaker: { turnId: 3, matched: false },
    });
  });

  it("discards a biometric result that arrives after a newer turn", () => {
    expect(
      resolveSpeakerUpdate(4, {
        type: "speaker",
        sessionId: "session",
        turnId: 3,
        matched: true,
        identityId: "old-speaker",
        name: "Old speaker",
        score: 0.9,
      }),
    ).toBeUndefined();
  });
});
