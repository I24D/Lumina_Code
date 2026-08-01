import { describe, expect, it, vi } from "vitest";

import { AudioProcessor } from "./AudioProcessor.js";
import { VoiceActivityGate } from "./VoiceActivityGate.js";

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

function createNoise(seed = 0x12345678): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

function createFrame(
  noise: () => number,
  noiseAmplitude: number,
  speechAmplitude: number,
  sampleOffset: number,
): Buffer {
  const frame = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
    const envelope = 0.55 + 0.45 * Math.sin(
      (2 * Math.PI * (sampleOffset + i)) / (SAMPLE_RATE * 0.16),
    );
    const speech =
      speechAmplitude *
      envelope *
      Math.sin((2 * Math.PI * 220 * (sampleOffset + i)) / SAMPLE_RATE);
    const value = Math.max(
      -32768,
      Math.min(32767, Math.round(noise() * noiseAmplitude + speech)),
    );
    frame.writeInt16LE(value, i * 2);
  }
  return frame;
}

function exercisePipeline(
  noiseAmplitude: number,
  speechAmplitude: number,
): { starts: number; ends: number } {
  const processor = new AudioProcessor();
  const onActivityStart = vi.fn();
  const onActivityEnd = vi.fn();
  const gate = new VoiceActivityGate({
    onActivityStart,
    onAudio: vi.fn(),
    onActivityEnd,
  });
  const noise = createNoise();
  let sampleOffset = 0;

  const push = (speech: number) => {
    const cleaned = processor.process(
      createFrame(noise, noiseAmplitude, speech, sampleOffset),
    );
    sampleOffset += SAMPLES_PER_FRAME;
    if (cleaned.length > 0) {
      gate.process(cleaned);
    }
  };

  // Let the suppressor and VAD observe the room before speech starts.
  for (let frame = 0; frame < 75; frame += 1) {
    push(0);
  }
  for (let frame = 0; frame < 40; frame += 1) {
    push(speechAmplitude);
  }
  for (let frame = 0; frame < 50; frame += 1) {
    push(0);
  }

  return {
    starts: onActivityStart.mock.calls.length,
    ends: onActivityEnd.mock.calls.length,
  };
}

describe("Start Talk microphone pipeline", () => {
  it("does not open a turn for stationary room noise", () => {
    expect(exercisePipeline(300, 0)).toEqual({ starts: 0, ends: 0 });
  });

  it("opens one turn for soft speech over moderate room noise", () => {
    expect(exercisePipeline(300, 450)).toEqual({ starts: 1, ends: 1 });
  });
});
