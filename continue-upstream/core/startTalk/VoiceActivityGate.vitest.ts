import { describe, expect, it, vi } from "vitest";

import { rmsOfS16, VoiceActivityGate } from "./VoiceActivityGate.js";

const SAMPLE_RATE = 16000;

/** Genera PCM s16le mono de `ms` con amplitud constante (RMS ≈ amplitude). */
function genPcm(ms: number, amplitude: number): Buffer {
  const sampleCount = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    // Alternamos el signo para simular una onda (RMS = |amplitude|).
    const value = i % 2 === 0 ? amplitude : -amplitude;
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

function makeGate(clock: { t: number }) {
  const onActivityStart = vi.fn();
  const onAudio = vi.fn();
  const onActivityEnd = vi.fn();
  const gate = new VoiceActivityGate(
    { onActivityStart, onAudio, onActivityEnd },
    undefined,
    () => clock.t,
  );
  return { gate, onActivityStart, onAudio, onActivityEnd };
}

describe("rmsOfS16", () => {
  it("mide la energía de un frame de amplitud constante", () => {
    expect(rmsOfS16(genPcm(20, 6000))).toBeCloseTo(6000, 0);
    expect(rmsOfS16(genPcm(20, 0))).toBe(0);
  });
});

describe("VoiceActivityGate", () => {
  it("ignora el silencio: no abre turno ni reenvía audio", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onAudio, onActivityEnd } = makeGate(clock);

    gate.process(genPcm(1000, 0));

    expect(onActivityStart).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
    expect(onActivityEnd).not.toHaveBeenCalled();
  });

  it("en modo normal abre y cierra un turno con voz sostenida", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onAudio, onActivityEnd } = makeGate(clock);

    gate.process(genPcm(300, 6000)); // voz
    gate.process(genPcm(900, 0)); // silencio para cerrar el turno

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls.length).toBeGreaterThan(0);
    expect(onActivityEnd).toHaveBeenCalledTimes(1);
    // Orden correcto: start ocurre antes que end.
    expect(onActivityStart.mock.invocationCallOrder[0]).toBeLessThan(
      onActivityEnd.mock.invocationCallOrder[0],
    );
  });

  it("detecta voz suave con huecos breves entre silabas", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onAudio } = makeGate(clock);

    gate.process(genPcm(500, 0));

    // Soft speech alternates stronger vowels with low-energy consonants. The
    // continuation threshold must preserve the candidate across those gaps.
    for (const amplitude of [260, 170, 260, 170, 260, 170, 260, 170]) {
      gate.process(genPcm(20, amplitude));
    }

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls.length).toBeGreaterThan(0);
  });

  it("mientras Lumina habla, un blip corto NO la interrumpe (anti-eco/muletilla)", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onActivityEnd } = makeGate(clock);

    // Lumina emite ~10s de audio → ventana de "hablando" activa.
    gate.noteAssistantAudio(480000, 24000);

    gate.process(genPcm(200, 6000)); // blip de 200 ms (< 450 ms exigidos)
    gate.process(genPcm(400, 0));

    expect(onActivityStart).not.toHaveBeenCalled();
    expect(onActivityEnd).not.toHaveBeenCalled();
  });

  it("mientras Lumina habla, voz real sostenida SÍ dispara barge-in", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onActivityEnd } = makeGate(clock);

    gate.noteAssistantAudio(480000, 24000); // ventana de "hablando" activa

    gate.process(genPcm(700, 9000)); // voz sostenida y clara (> 450 ms)
    gate.process(genPcm(900, 0));

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onActivityEnd).toHaveBeenCalledTimes(1);
  });

  it("half-duplex: mientras Lumina habla, NI la voz sostenida abre turno", () => {
    const clock = { t: 0 };
    const onActivityStart = vi.fn();
    const onAudio = vi.fn();
    const onActivityEnd = vi.fn();
    const gate = new VoiceActivityGate(
      { onActivityStart, onAudio, onActivityEnd },
      { halfDuplex: true },
      () => clock.t,
    );

    gate.noteAssistantAudio(480000, 24000); // ~10 s de habla → ventana activa
    gate.process(genPcm(700, 9000)); // voz fuerte y sostenida (sería barge-in)

    expect(onActivityStart).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
  });

  it("half-duplex: cuando Lumina termina de hablar, vuelve a escuchar", () => {
    const clock = { t: 0 };
    const onActivityStart = vi.fn();
    const onAudio = vi.fn();
    const onActivityEnd = vi.fn();
    const gate = new VoiceActivityGate(
      { onActivityStart, onAudio, onActivityEnd },
      { halfDuplex: true },
      () => clock.t,
    );

    gate.noteAssistantAudio(480000, 24000); // ventana ~10 s (+ tail)
    clock.t = 11000; // ya terminó de hablar y pasó el tail

    gate.process(genPcm(300, 6000)); // voz
    gate.process(genPcm(900, 0)); // silencio para cerrar

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onActivityEnd).toHaveBeenCalledTimes(1);
  });

  it("reset() cierra un turno abierto para no dejar actividad colgada", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onActivityEnd } = makeGate(clock);

    gate.process(genPcm(300, 6000)); // abre turno, sin silencio de cierre
    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onActivityEnd).not.toHaveBeenCalled();

    gate.reset();
    expect(onActivityEnd).toHaveBeenCalledTimes(1);
  });
});
