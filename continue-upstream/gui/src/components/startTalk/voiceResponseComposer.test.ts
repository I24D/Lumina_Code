import { describe, expect, it } from "vitest";

import {
  composeVoiceResponse,
  StreamingSentenceSegmenter,
} from "./voiceResponseComposer";

describe("composeVoiceResponse", () => {
  it("keeps prose while leaving code and long URLs on screen", () => {
    const spoken = composeVoiceResponse(
      "Revisa [la guía](https://example.com/a/very/long/path). ```ts\nconst x = 1;\n```",
    );
    expect(spoken).toContain("Revisa la guía.");
    expect(spoken).toContain("Te dejé el código en pantalla.");
    expect(spoken).toContain("Te dejé los enlaces en pantalla.");
    expect(spoken).not.toContain("https://");
    expect(spoken).not.toContain("const x");
  });
});

describe("StreamingSentenceSegmenter", () => {
  it("releases the first sentence while the model is still generating", () => {
    const segmenter = new StreamingSentenceSegmenter();
    expect(segmenter.push("La primera parte ya está lista. La seg")).toEqual([
      "La primera parte ya está lista.",
    ]);
    expect(segmenter.push("unda continúa")).toEqual([]);
    expect(segmenter.flush()).toEqual(["La segunda continúa"]);
  });
});
