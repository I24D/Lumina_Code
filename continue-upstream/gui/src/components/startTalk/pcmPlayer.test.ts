import { describe, expect, it } from "vitest";

import { pcm16Base64ToFloat32, resampleLinear } from "./pcmPlayer";

/** Codifica muestras s16 little-endian a base64, como llega de la Live API. */
function encodePcm16(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("pcm16Base64ToFloat32", () => {
  it("normaliza a [-1, 1] respetando el signo", () => {
    const out = pcm16Base64ToFloat32(encodePcm16([0, 16384, -16384]));

    expect(out).toHaveLength(3);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(-0.5, 5);
  });

  it("maneja los extremos del rango s16 sin desbordar", () => {
    // 0x8000 es -32768: si se leyera sin signo saldría +1 en vez de -1, que es
    // exactamente el fallo clásico al decodificar PCM a mano.
    const out = pcm16Base64ToFloat32(encodePcm16([32767, -32768]));

    expect(out[0]).toBeCloseTo(0.999969, 4);
    expect(out[1]).toBeCloseTo(-1, 5);
  });

  it("devuelve vacío para una cadena vacía", () => {
    expect(pcm16Base64ToFloat32("")).toHaveLength(0);
  });
});

describe("resampleLinear", () => {
  it("no toca nada cuando las tasas coinciden", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, 24000, 24000)).toBe(input);
  });

  it("duplica la longitud al doblar la tasa", () => {
    const input = new Float32Array([0, 1, 0, 1]);
    const out = resampleLinear(input, 24000, 48000);
    expect(out).toHaveLength(8);
  });

  it("reduce la longitud al bajar la tasa", () => {
    const input = new Float32Array(100).fill(0.5);
    const out = resampleLinear(input, 48000, 24000);
    expect(out).toHaveLength(50);
    expect(out[10]).toBeCloseTo(0.5, 5);
  });

  it("interpola de verdad entre muestras", () => {
    const out = resampleLinear(new Float32Array([0, 1]), 1, 2);
    // A doble de tasa, la muestra intermedia debe caer entre las dos.
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThanOrEqual(1);
  });

  it("no revienta con entrada vacía", () => {
    expect(resampleLinear(new Float32Array(0), 24000, 48000)).toHaveLength(0);
  });
});
