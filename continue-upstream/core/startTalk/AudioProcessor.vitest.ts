import { describe, expect, it } from "vitest";

import { AudioProcessor, fftInPlace } from "./AudioProcessor";

/** Deterministic LCG so noise tests are reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff; // [0, 1)
  };
}

function rmsOfPcm(buffer: Buffer): number {
  const count = Math.floor(buffer.length / 2);
  if (count === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const s = buffer.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / count);
}

function floatArrayToPcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

describe("fftInPlace", () => {
  it("round-trips a signal through FFT and inverse FFT", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8];
    const re = Float64Array.from(original);
    const im = new Float64Array(8);

    fftInPlace(re, im, false);
    fftInPlace(re, im, true);

    for (let i = 0; i < original.length; i += 1) {
      expect(re[i]).toBeCloseTo(original[i], 6);
      expect(im[i]).toBeCloseTo(0, 6);
    }
  });

  it("puts a DC signal's energy in bin 0", () => {
    const re = Float64Array.from([2, 2, 2, 2]);
    const im = new Float64Array(4);
    fftInPlace(re, im, false);
    expect(re[0]).toBeCloseTo(8, 6); // sum of samples
    expect(re[1]).toBeCloseTo(0, 6);
    expect(re[2]).toBeCloseTo(0, 6);
  });
});

describe("AudioProcessor", () => {
  it("keeps silence silent through the full chain", () => {
    const processor = new AudioProcessor();
    const silence = Buffer.alloc(4096); // 2048 zero samples
    const out = processor.process(silence);
    expect(rmsOfPcm(out)).toBeLessThan(1);
    expect(out.length % 2).toBe(0);
  });

  it("removes a large DC offset via the high-pass stage", () => {
    const processor = new AudioProcessor({
      highPass: true,
      noiseSuppression: false,
      agc: false,
    });
    const samples = new Array(4000).fill(5000); // constant DC offset
    const out = processor.process(floatArrayToPcm(samples));

    // After the filter settles, the tail should be near zero (DC removed).
    const count = Math.floor(out.length / 2);
    let tailSum = 0;
    const tailStart = Math.max(0, count - 500);
    for (let i = tailStart; i < count; i += 1) {
      tailSum += Math.abs(out.readInt16LE(i * 2));
    }
    const tailMean = tailSum / Math.max(1, count - tailStart);
    expect(tailMean).toBeLessThan(200);
  });

  it("boosts a quiet signal toward the AGC target RMS", () => {
    const processor = new AudioProcessor({
      highPass: false,
      noiseSuppression: false,
      agc: true,
      agcTargetRms: 4000,
      agcMaxGain: 12,
    });

    // Quiet 220 Hz tone, RMS ≈ 353.
    const build = () => {
      const samples: number[] = [];
      for (let i = 0; i < 1600; i += 1) {
        samples.push(500 * Math.sin((2 * Math.PI * 220 * i) / 16000));
      }
      return floatArrayToPcm(samples);
    };

    const inputRms = rmsOfPcm(build());
    let lastRms = 0;
    for (let block = 0; block < 20; block += 1) {
      lastRms = rmsOfPcm(processor.process(build()));
    }
    expect(lastRms).toBeGreaterThan(inputRms * 2);
  });

  it("applies comparable AGC gain across different FFmpeg chunk sizes", () => {
    const measureTail = (chunkSamples: number) => {
      const processor = new AudioProcessor({
        highPass: false,
        noiseSuppression: false,
        agc: true,
        agcInitialGain: 1,
      });
      let sampleOffset = 0;
      let tailRms = 0;
      while (sampleOffset < 16000) {
        const sampleCount = Math.min(chunkSamples, 16000 - sampleOffset);
        const samples: number[] = [];
        for (let i = 0; i < sampleCount; i += 1) {
          samples.push(
            450 *
              Math.sin((2 * Math.PI * 220 * (sampleOffset + i)) / 16000),
          );
        }
        tailRms = rmsOfPcm(processor.process(floatArrayToPcm(samples)));
        sampleOffset += sampleCount;
      }
      return tailRms;
    };

    const smallChunks = measureTail(320);
    const largeChunks = measureTail(1600);
    expect(smallChunks / largeChunks).toBeGreaterThan(0.9);
    expect(smallChunks / largeChunks).toBeLessThan(1.1);
  });

  it("reduces the level of stationary white noise", () => {
    const processor = new AudioProcessor({
      highPass: false,
      noiseSuppression: true,
      agc: false,
    });
    const rng = makeRng(12345);
    const buildNoise = () => {
      const samples: number[] = [];
      for (let i = 0; i < 2048; i += 1) {
        samples.push((rng() * 2 - 1) * 2000);
      }
      return floatArrayToPcm(samples);
    };

    let inputRms = 0;
    let outputRms = 0;
    // Let the noise estimate adapt, then measure a later block.
    for (let block = 0; block < 12; block += 1) {
      const input = buildNoise();
      inputRms = rmsOfPcm(input);
      outputRms = rmsOfPcm(processor.process(input));
    }
    expect(outputRms).toBeLessThan(inputRms);
  });

  it("handles arbitrary chunk sizes without throwing", () => {
    const processor = new AudioProcessor();
    const sizes = [17, 640, 1, 4095, 8192];
    for (const size of sizes) {
      const chunk = Buffer.alloc(size);
      expect(() => processor.process(chunk)).not.toThrow();
    }
  });
});
