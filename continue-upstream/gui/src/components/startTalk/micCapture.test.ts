import { describe, expect, it } from "vitest";

import {
  MIC_FRAME_DURATION_MS,
  MIC_FRAME_SAMPLES,
  MIC_SAMPLE_RATE,
} from "./micCapture";

describe("Start Talk microphone transport", () => {
  it("envía bloques interactivos de 40 ms a 16 kHz", () => {
    expect(MIC_SAMPLE_RATE).toBe(16_000);
    expect(MIC_FRAME_SAMPLES).toBe(640);
    expect(MIC_FRAME_DURATION_MS).toBe(40);
  });
});
