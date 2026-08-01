import { describe, expect, it } from "vitest";

import { splitMjpegStream } from "./FfmpegVideoCapture.js";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** Un "JPEG" mínimo: SOI + payload + EOI. */
function frame(...payload: number[]): Buffer {
  return Buffer.from([...SOI, ...payload, ...EOI]);
}

describe("splitMjpegStream", () => {
  it("extrae dos fotogramas completos consecutivos", () => {
    const a = frame(1, 2, 3);
    const b = frame(4, 5);
    const { frames, rest } = splitMjpegStream(Buffer.concat([a, b]));

    expect(frames).toHaveLength(2);
    expect(frames[0].equals(a)).toBe(true);
    expect(frames[1].equals(b)).toBe(true);
    expect(rest).toHaveLength(0);
  });

  it("conserva un fotograma incompleto como resto", () => {
    const complete = frame(1, 2);
    const partial = Buffer.from([...SOI, 9, 9]); // sin EOI
    const { frames, rest } = splitMjpegStream(
      Buffer.concat([complete, partial]),
    );

    expect(frames).toHaveLength(1);
    expect(rest.equals(partial)).toBe(true);
  });

  it("descarta ruido previo al primer SOI", () => {
    const noise = Buffer.from([0x00, 0x11, 0x22]);
    const a = frame(7);
    const { frames, rest } = splitMjpegStream(Buffer.concat([noise, a]));

    expect(frames).toHaveLength(1);
    expect(frames[0].equals(a)).toBe(true);
    expect(rest).toHaveLength(0);
  });

  it("sin SOI no devuelve nada y limpia el buffer", () => {
    const { frames, rest } = splitMjpegStream(Buffer.from([0x00, 0x01, 0x02]));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(0);
  });

  it("reensambla un fotograma partido entre dos chunks", () => {
    const full = frame(1, 2, 3, 4);
    const cut = 3;
    const first = splitMjpegStream(full.subarray(0, cut));
    expect(first.frames).toHaveLength(0);

    const second = splitMjpegStream(
      Buffer.concat([first.rest, full.subarray(cut)]),
    );
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].equals(full)).toBe(true);
    expect(second.rest).toHaveLength(0);
  });
});
