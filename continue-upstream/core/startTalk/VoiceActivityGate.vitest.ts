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

/**
 * Bulla de sala: varias voces solapadas. Energía siempre por encima del umbral
 * de voz, con variación natural pero SIN silencios reales.
 */
function babbleFrame(index: number): Buffer {
  const amplitude = Math.max(
    400,
    Math.round(
      2600 + Math.sin(index / 3) * 900 + Math.sin(index / 7) * 500,
    ),
  );
  return genPcm(20, amplitude);
}

function makeGate(
  clock: { t: number },
  options?: ConstructorParameters<typeof VoiceActivityGate>[1],
) {
  const onActivityStart = vi.fn();
  const onAudio = vi.fn();
  const onActivityEnd = vi.fn();
  const onEnvironmentChange = vi.fn();
  const gate = new VoiceActivityGate(
    { onActivityStart, onAudio, onActivityEnd, onEnvironmentChange },
    options,
    () => clock.t,
  );
  return { gate, onActivityStart, onAudio, onActivityEnd, onEnvironmentChange };
}

/** Reproduce `ms` de audio a la amplitud dada, avanzando el reloj inyectado. */
function feed(
  gate: VoiceActivityGate,
  clock: { t: number },
  ms: number,
  amplitude: number,
): void {
  const frames = Math.floor(ms / 20);
  for (let i = 0; i < frames; i++) {
    gate.process(genPcm(20, amplitude));
    clock.t += 20;
  }
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

describe("VoiceActivityGate: entorno con varias voces", () => {
  it("REGRESIÓN: en bulla continua el turno se cierra igual y Gemini puede responder", () => {
    // Este es el fallo que hacía que Lumina pareciera muda en una sala con
    // gente: el cierre por silencio (650 ms) NO llega nunca, así que sin techo
    // de turno jamás se enviaba activityEnd y el modelo no recibía permiso
    // para hablar. Medido antes del arreglo: 1 activityStart, 0 activityEnd,
    // 60 s de audio transmitido para nada.
    const clock = { t: 0 };
    const { gate, onActivityStart, onActivityEnd } = makeGate(clock);

    for (let i = 0; i < 3000; i++) {
      // 60 s
      gate.process(babbleFrame(i));
      clock.t += 20;
    }

    expect(onActivityEnd.mock.calls.length).toBeGreaterThan(0);
    // Y no se queda en un único turno eterno: va cediendo turnos.
    expect(onActivityStart.mock.calls.length).toBeGreaterThan(1);
    // Como mucho queda uno abierto al cortar la grabación.
    const open =
      onActivityStart.mock.calls.length - onActivityEnd.mock.calls.length;
    expect(open).toBeGreaterThanOrEqual(0);
    expect(open).toBeLessThanOrEqual(1);
  });

  it("ningún turno supera el techo de duración", () => {
    const clock = { t: 0 };
    const events: Array<{ kind: "start" | "end"; at: number }> = [];
    const gate = new VoiceActivityGate(
      {
        onActivityStart: () => events.push({ kind: "start", at: clock.t }),
        onAudio: () => undefined,
        onActivityEnd: () => events.push({ kind: "end", at: clock.t }),
      },
      { maxTurnMs: 8_000 },
      () => clock.t,
    );

    for (let i = 0; i < 2500; i++) {
      gate.process(babbleFrame(i));
      clock.t += 20;
    }

    for (let i = 0; i + 1 < events.length; i += 2) {
      expect(events[i].kind).toBe("start");
      expect(events[i + 1].kind).toBe("end");
      expect(events[i + 1].at - events[i].at).toBeLessThanOrEqual(8_000);
    }
  });

  it("avisa cuando el entorno pasa a tener varias voces solapadas", () => {
    const clock = { t: 0 };
    const { gate, onEnvironmentChange } = makeGate(clock);

    for (let i = 0; i < 1000; i++) {
      gate.process(babbleFrame(i));
      clock.t += 20;
    }

    expect(onEnvironmentChange).toHaveBeenCalledWith(true);
    expect(gate.isCrowded()).toBe(true);
  });

  it("una sola persona con pausas naturales NO cuenta como entorno con gente", () => {
    const clock = { t: 0 };
    const { gate, onEnvironmentChange } = makeGate(clock);

    for (let turn = 0; turn < 6; turn++) {
      feed(gate, clock, 2_000, 6000); // habla
      feed(gate, clock, 1_000, 40); // pausa real
    }

    expect(gate.isCrowded()).toBe(false);
    expect(onEnvironmentChange).not.toHaveBeenCalledWith(true);
  });
});

describe("VoiceActivityGate: interrupción mientras Lumina habla", () => {
  it("su propio eco continuo NO la corta", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(20_000); // le quedan 20 s por sonar
    // Eco de su voz: continuo y sin huecos largos, 10 s seguidos.
    feed(gate, clock, 10_000, 3000);

    expect(onActivityStart).not.toHaveBeenCalled();
  });

  it("la bulla de una sala tampoco la corta", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(20_000);
    for (let i = 0; i < 500; i++) {
      gate.process(babbleFrame(i));
      clock.t += 20;
    }

    expect(onActivityStart).not.toHaveBeenCalled();
  });

  it("una interjección corta y mucho más fuerte que el eco SÍ la corta", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onAudio } = makeGate(clock);

    gate.setPlaybackRemaining(20_000);
    feed(gate, clock, 3_000, 900); // eco de fondo, aprende el nivel
    feed(gate, clock, 400, 9000); // "¡para!" muy por encima del eco
    feed(gate, clock, 400, 900); // vuelve al eco: confirma el final

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    // La orden se le manda al modelo, no se descarta.
    expect(onAudio.mock.calls.length).toBeGreaterThan(0);
  });

  it("un grito LARGO no cuenta como orden corta", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(20_000);
    feed(gate, clock, 3_000, 900); // eco de fondo
    feed(gate, clock, 3_000, 9000); // habla continua fuerte, no una interjección
    feed(gate, clock, 400, 900);

    expect(onActivityStart).not.toHaveBeenCalled();
  });

  it("el margen de cola sigue vigente cuando la cola se vacía", () => {
    // `setPlaybackRemaining(0)` llevaba el plazo a cero, así que el margen de
    // cola no llegaba a aplicarse nunca por la ruta normal: el micro se abría
    // en el instante en que el último fragmento salía hacia los altavoces.
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(1_000);
    feed(gate, clock, 1_000, 900); // su voz sonando
    gate.setPlaybackRemaining(0); // la cola queda vacía

    feed(gate, clock, 400, 900); // todavía se la oye por el altavoz
    expect(onActivityStart).not.toHaveBeenCalled();

    clock.t += 400; // pasado el margen, el micro vuelve a ser suyo
    feed(gate, clock, 300, 900);
    expect(onActivityStart).toHaveBeenCalledTimes(1);
  });

  it("un corte deliberado abre el micro sin esperar al margen", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(20_000);
    feed(gate, clock, 200, 900);
    gate.setAssistantSpeaking(false); // la cortó de verdad

    feed(gate, clock, 300, 900);
    expect(onActivityStart).toHaveBeenCalledTimes(1);
  });

  it("bargeMode 'off' la hace totalmente incortable", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onAudio } = makeGate(clock, {
      bargeMode: "off",
    });

    gate.setPlaybackRemaining(20_000);
    feed(gate, clock, 3_000, 900);
    feed(gate, clock, 400, 12000);
    feed(gate, clock, 400, 900);

    expect(onActivityStart).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
  });

  it("bargeMode 'energy' recupera el barge-in clásico por voz sostenida", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart, onActivityEnd } = makeGate(clock, {
      bargeMode: "energy",
    });

    gate.noteAssistantAudio(480000, 24000); // ~10 s de habla
    gate.process(genPcm(700, 9000)); // voz sostenida y clara (> 450 ms)
    gate.process(genPcm(900, 0));

    expect(onActivityStart).toHaveBeenCalledTimes(1);
    expect(onActivityEnd).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceActivityGate: la reproducción real manda", () => {
  it("setPlaybackRemaining mantiene el micro cerrado aunque el reloj avance", () => {
    // El servidor entrega el audio hasta 3x más rápido que el tiempo real, así
    // que la estimación por hora de llegada se queda corta si la reproducción
    // se atrasa o se suspende. Si la GUI dice que aún quedan 30 s sonando, el
    // gate debe seguir tratando el micro como eco.
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.noteAssistantAudio(48000, 24000); // estimación: solo 1 s
    clock.t = 5_000; // la estimación ya expiró
    gate.setPlaybackRemaining(30_000); // pero la GUI aún tiene 30 s en cola

    feed(gate, clock, 5_000, 6000); // voz sostenida: sería barge-in por energía

    expect(onActivityStart).not.toHaveBeenCalled();
  });

  it("setPlaybackRemaining(0) reabre el micro en el acto", () => {
    const clock = { t: 0 };
    const { gate, onActivityStart } = makeGate(clock);

    gate.setPlaybackRemaining(30_000);
    gate.setPlaybackRemaining(0); // la reproducción terminó (o la cortaron)

    feed(gate, clock, 400, 6000);

    expect(onActivityStart).toHaveBeenCalledTimes(1);
  });
});
