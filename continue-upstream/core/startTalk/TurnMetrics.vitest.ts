import { describe, expect, it } from "vitest";

import { percentile, TurnMetricsTracker } from "./TurnMetrics.js";

/** 1 s de PCM a 24 kHz s16 = 48000 bytes. */
function secondsOfAudio(seconds: number): number {
  return Math.round(seconds * 24000 * 2);
}

function makeTracker() {
  const clock = { t: 0 };
  return { clock, tracker: new TurnMetricsTracker(() => clock.t) };
}

describe("percentile", () => {
  it("devuelve undefined sin datos", () => {
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it("calcula mediana y p90", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.9)).toBe(90);
  });

  it("no altera el array original", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("TurnMetricsTracker", () => {
  it("mide la latencia de respuesta desde el fin del turno del usuario", () => {
    const { clock, tracker } = makeTracker();

    clock.t = 1_000;
    tracker.onActivityStart();
    tracker.onUserTranscript("¿qué hora es?");
    clock.t = 3_000;
    tracker.onActivityEnd();
    clock.t = 3_850; // primer audio 850 ms después
    tracker.onAssistantAudio(secondsOfAudio(0.5), 24000);
    clock.t = 5_000;
    const metrics = tracker.onTurnComplete()!;

    expect(metrics.userSpeechMs).toBe(2_000);
    expect(metrics.responseLatencyMs).toBe(850);
    expect(metrics.turnId).toBe(1);
  });

  it("mide la latencia percibida incluyendo el cierre local del VAD", () => {
    const { clock, tracker } = makeTracker();

    clock.t = 1_000;
    tracker.onActivityStart();
    tracker.onUserTranscript("hola");
    clock.t = 3_520;
    tracker.onActivityEnd(520);
    clock.t = 4_120;
    tracker.onAssistantAudio(secondsOfAudio(0.2), 24000);

    const metrics = tracker.onTurnComplete()!;
    expect(metrics.userSpeechMs).toBe(2_000);
    expect(metrics.endpointingLatencyMs).toBe(520);
    expect(metrics.serverResponseLatencyMs).toBe(600);
    expect(metrics.responseLatencyMs).toBe(1_120);
  });

  it("separa STT, primer token, herramienta y primer audio", () => {
    const { clock, tracker } = makeTracker();
    clock.t = 1_000;
    tracker.onActivityStart();
    clock.t = 1_180;
    tracker.onUserTranscript("busca esto");
    clock.t = 2_000;
    tracker.onActivityEnd(520);
    tracker.onToolCall("search");
    clock.t = 2_350;
    tracker.onToolResult("search");
    clock.t = 2_420;
    tracker.onAssistantTranscript("Encontré");
    clock.t = 2_600;
    tracker.onAssistantAudio(secondsOfAudio(0.2), 24_000);

    expect(tracker.onTurnComplete()).toMatchObject({
      sttFirstPartialMs: 180,
      llmFirstTokenMs: 420,
      toolLatencyMs: 350,
      serverResponseLatencyMs: 600,
    });
  });

  it("mide la velocidad de entrega, que es lo que llena la cola", () => {
    const { clock, tracker } = makeTracker();

    tracker.onActivityStart();
    tracker.onUserTranscript("cuéntame algo largo");
    clock.t = 1_000;
    tracker.onActivityEnd();

    // 30 s de audio entregados en 10 s de reloj => 3x tiempo real.
    clock.t = 2_000;
    tracker.onAssistantAudio(secondsOfAudio(15), 24000);
    clock.t = 12_000;
    tracker.onAssistantAudio(secondsOfAudio(15), 24000);

    const metrics = tracker.onTurnComplete()!;
    expect(metrics.assistantAudioSeconds).toBeCloseTo(30, 1);
    expect(metrics.deliveryRate).toBeCloseTo(3, 1);
    expect(metrics.assistantChunks).toBe(2);
  });

  it("marca falso inicio cuando el gate se abrió sin voz real", () => {
    const { clock, tracker } = makeTracker();

    tracker.onActivityStart(); // ruido que abrió el gate
    clock.t = 400;
    tracker.onActivityEnd();
    const metrics = tracker.onTurnComplete()!;

    expect(metrics.falseStart).toBe(true);
    expect(tracker.sessionMetrics().falseStarts).toBe(1);
  });

  it("un turno con transcripción NO es falso inicio", () => {
    const { tracker } = makeTracker();

    tracker.onActivityStart();
    tracker.onUserTranscript("hola");
    tracker.onActivityEnd();

    expect(tracker.onTurnComplete()!.falseStart).toBe(false);
  });

  it("callarse a propósito no cuenta como falso inicio", () => {
    // stay_silent significa que oyó voz y decidió que no era para ella; contarlo
    // como falso positivo del gate ensuciaria justo la metrica que sirve para
    // afinar el VAD.
    const { tracker } = makeTracker();

    tracker.onActivityStart();
    tracker.onActivityEnd();
    tracker.onStayedSilent();
    const metrics = tracker.onTurnComplete()!;

    expect(metrics.stayedSilent).toBe(true);
    expect(metrics.falseStart).toBe(false);
    expect(tracker.sessionMetrics().silentTurns).toBe(1);
  });

  it("registra interrupciones", () => {
    const { tracker } = makeTracker();

    tracker.onActivityStart();
    tracker.onUserTranscript("para");
    tracker.onActivityEnd();
    tracker.onAssistantAudio(secondsOfAudio(1), 24000);
    tracker.onInterrupted();

    expect(tracker.onTurnComplete()!.interrupted).toBe(true);
    expect(tracker.sessionMetrics().interruptions).toBe(1);
  });

  it("no arrastra estado de un turno al siguiente", () => {
    const { clock, tracker } = makeTracker();

    tracker.onActivityStart();
    tracker.onActivityEnd();
    tracker.onInterrupted();
    tracker.onTurnComplete();

    clock.t = 10_000;
    tracker.onActivityStart();
    tracker.onUserTranscript("segunda pregunta");
    clock.t = 11_000;
    tracker.onActivityEnd();
    const second = tracker.onTurnComplete()!;

    expect(second.turnId).toBe(2);
    expect(second.interrupted).toBe(false);
    expect(second.falseStart).toBe(false);
  });

  it("ignora un turnComplete suelto sin turno en curso", () => {
    const { tracker } = makeTracker();
    expect(tracker.onTurnComplete()).toBeUndefined();
  });

  it("acumula percentiles de latencia en la sesión", () => {
    const { clock, tracker } = makeTracker();

    for (const latency of [200, 400, 600, 800, 1000]) {
      tracker.onActivityStart();
      tracker.onUserTranscript("x");
      tracker.onActivityEnd();
      const base = clock.t;
      clock.t = base + latency;
      tracker.onAssistantAudio(secondsOfAudio(0.2), 24000);
      tracker.onTurnComplete();
      clock.t += 1_000;
    }

    const session = tracker.sessionMetrics();
    expect(session.turns).toBe(5);
    expect(session.medianResponseLatencyMs).toBe(600);
    expect(session.p90ResponseLatencyMs).toBe(1000);
  });

  it("cuenta reconexiones, reinicios de vídeo y búsquedas de la sesión", () => {
    const { tracker } = makeTracker();

    tracker.onReconnect();
    tracker.onVideoRestart();
    tracker.onSearch();

    const session = tracker.sessionMetrics();
    expect(session.reconnects).toBe(1);
    expect(session.videoRestarts).toBe(1);
    expect(session.searches).toBe(1);
  });

  it("accounts only for audio that crossed the VAD and actual tool calls", () => {
    const { tracker } = makeTracker();
    tracker.onActivityStart();
    tracker.onUserAudio(16_000 * 2 * 2, 16_000);
    tracker.onActivityEnd();
    tracker.onAssistantAudio(secondsOfAudio(3), 24_000);
    tracker.onToolCall();

    const turn = tracker.onTurnComplete()!;
    const session = tracker.sessionMetrics();
    expect(turn.inputAudioSeconds).toBe(2);
    expect(session.inputAudioSeconds).toBe(2);
    expect(session.assistantAudioSeconds).toBe(3);
    expect(session.toolCalls).toBe(1);
  });

  it("only reports a cost when explicit rates were configured", () => {
    const tracker = new TurnMetricsTracker(() => 0, {
      inputAudioUsdPerMinute: 0.06,
      outputAudioUsdPerMinute: 0.12,
      toolCallUsd: 0.01,
    });
    tracker.onUserAudio(16_000 * 2 * 60, 16_000);
    tracker.onAssistantAudio(24_000 * 2 * 60, 24_000);
    tracker.onToolCall();

    expect(tracker.sessionMetrics().estimatedCostUsd).toBe(0.19);
  });
});
