import { describe, expect, it } from "vitest";

import { SoundEventDetector } from "./SoundEventDetector";

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function window(fill: (i: number) => number): Float64Array {
  const out = new Float64Array(512);
  for (let i = 0; i < 512; i += 1) {
    out[i] = fill(i);
  }
  return out;
}

describe("SoundEventDetector.classifyWindow", () => {
  const detector = new SoundEventDetector();

  it("classifies silence", () => {
    expect(detector.classifyWindow(window(() => 0)).category).toBe("silence");
  });

  it("classifies a pure tone as tonal", () => {
    const tone = window((i) => 6000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
    expect(detector.classifyWindow(tone).category).toBe("tonal");
  });

  it("classifies white noise as broadband", () => {
    const rng = makeRng(7);
    const noise = window(() => (rng() * 2 - 1) * 6000);
    expect(detector.classifyWindow(noise).category).toBe("broadband");
  });

  it("classifies a high-crest transient as impulsive", () => {
    const impulse = window((i) => (i === 256 ? 25000 : 0));
    expect(detector.classifyWindow(impulse).category).toBe("impulsive");
  });
});

describe("SoundEventDetector.process", () => {
  it("debounces and emits on category change", () => {
    const detector = new SoundEventDetector({ debounceWindows: 1 });
    const toPcm = (samples: Float64Array) => {
      const buf = Buffer.alloc(samples.length * 2);
      for (let i = 0; i < samples.length; i += 1) {
        buf.writeInt16LE(
          Math.max(-32768, Math.min(32767, Math.round(samples[i]))),
          i * 2,
        );
      }
      return buf;
    };

    const tone = window((i) => 6000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
    const first = detector.process(toPcm(tone));
    expect(first?.category).toBe("tonal");

    // Same category again → no new event (debounced).
    const second = detector.process(toPcm(tone));
    expect(second).toBeNull();
  });
});
