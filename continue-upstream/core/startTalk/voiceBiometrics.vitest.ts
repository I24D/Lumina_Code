import { describe, expect, it } from "vitest";

import { encodeWav } from "./voiceBiometrics";

describe("encodeWav", () => {
  it("prepends a valid 44-byte PCM WAV header", () => {
    const pcm = Buffer.alloc(320); // 160 samples
    const wav = encodeWav(pcm, 16000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000 * 2); // byte rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
  });

  it("carries the sample rate into the header", () => {
    const wav = encodeWav(Buffer.alloc(64), 24000);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(24000 * 2);
  });
});
