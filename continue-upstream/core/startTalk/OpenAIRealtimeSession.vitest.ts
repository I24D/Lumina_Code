import type { LiveServerMessage } from "@google/genai";
import { describe, expect, it } from "vitest";

import {
  flattenClientTurns,
  OpenAIRealtimeSession,
  PcmUpsampler,
  toRealtimeTools,
  type RealtimeSocket,
} from "./OpenAIRealtimeSession.js";

function createSession() {
  const sent: Array<Record<string, unknown>> = [];
  const received: LiveServerMessage[] = [];
  const socket: RealtimeSocket = {
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => undefined,
  };
  const session = new OpenAIRealtimeSession(
    socket,
    "gpt-realtime-2.1",
    {
      instructions: "be lumina",
      voice: "marin",
      thinkingLevel: "low",
      tools: [],
    },
    {
      onopen: () => undefined,
      onmessage: (message) => received.push(message),
      onerror: () => undefined,
      onclose: () => undefined,
    },
  );
  return { session, sent, received, types: () => sent.map((e) => e.type) };
}

/** 40 ms de PCM s16le a 16 kHz. */
function captureBlock(): Buffer {
  return Buffer.alloc(640 * 2);
}

describe("session configuration", () => {
  it("pins the young-female voice and disables the server VAD", () => {
    const { session } = createSession();
    const config = session.sessionConfig() as {
      audio: {
        input: { turn_detection: unknown };
        output: { voice: string };
      };
      reasoning: { effort: string };
    };

    // El turno lo abre y lo cierra VoiceActivityGate: si la VAD del servidor
    // quedara activa, el eco de la propia voz de Lumina la interrumpiría.
    expect(config.audio.input.turn_detection).toBeNull();
    expect(config.audio.output.voice).toBe("marin");
    expect(config.reasoning.effort).toBe("low");
  });
});

describe("turn lifecycle", () => {
  it("commits the buffer and asks for a response when the turn closes", () => {
    const { session, types } = createSession();

    session.sendRealtimeInput({ activityStart: {} });
    for (let i = 0; i < 5; i += 1) {
      session.sendRealtimeInput({
        audio: { data: captureBlock().toString("base64") },
      });
    }
    session.sendRealtimeInput({ activityEnd: {} });

    expect(types()).toEqual([
      "input_audio_buffer.clear",
      ...Array(5).fill("input_audio_buffer.append"),
      "input_audio_buffer.commit",
      "response.create",
    ]);
  });

  it("drops a turn too short for the API instead of committing it", () => {
    // Un commit con menos de 100 ms de audio lo rechaza la API; descartarlo
    // evita un error por cada falso positivo del gate.
    const { session, types } = createSession();

    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: { data: Buffer.alloc(160 * 2).toString("base64") },
    });
    session.sendRealtimeInput({ activityEnd: {} });

    expect(types()).not.toContain("input_audio_buffer.commit");
    expect(types()).not.toContain("response.create");
  });

  it("cancels the response in flight when the user barges in", () => {
    const { session, sent, received, types } = createSession();

    session.sendClientContent({ turns: "hola" });
    sent.length = 0;
    session.sendRealtimeInput({ activityStart: {} });

    expect(types()).toEqual(["response.cancel", "input_audio_buffer.clear"]);
    expect(received.at(-1)?.serverContent?.interrupted).toBe(true);
  });
});

describe("client content", () => {
  it("adds context without asking for speech when turnComplete is false", () => {
    // Los avisos de entorno cambian cómo decide intervenir; hacerla hablar
    // sería justo lo contrario de lo que piden.
    const { session, types } = createSession();

    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "hay varias voces" }] }],
      turnComplete: false,
    });

    expect(types()).toEqual(["conversation.item.create"]);
  });
});

describe("tool responses", () => {
  it("stays silent after stay_silent instead of speaking the result", () => {
    const { session, types } = createSession();

    session.sendToolResponse({
      functionResponses: [
        { id: "call_1", name: "stay_silent", response: { output: "ok" } },
      ],
    });

    expect(types()).toEqual(["conversation.item.create"]);
  });

  it("reads any other tool result aloud", () => {
    const { session, sent, types } = createSession();

    session.sendToolResponse({
      functionResponses: [
        { id: "call_2", name: "search_web", response: { answer: "42" } },
      ],
    });

    expect(types()).toEqual(["conversation.item.create", "response.create"]);
    expect(sent[0].item).toMatchObject({
      type: "function_call_output",
      call_id: "call_2",
    });
  });
});

describe("server events", () => {
  it("translates audio, transcripts and function calls to the Live shape", () => {
    const { session, received } = createSession();

    session.handleServerEvent(
      JSON.stringify({ type: "response.output_audio.delta", delta: "AAAA" }),
    );
    session.handleServerEvent(
      JSON.stringify({
        type: "response.output_audio_transcript.delta",
        delta: "hola",
      }),
    );
    session.handleServerEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "qué hora es",
      }),
    );
    session.handleServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call_3",
        name: "search_web",
        arguments: '{"query":"hora"}',
      }),
    );

    expect(received[0].serverContent?.modelTurn?.parts?.[0].inlineData).toEqual(
      { data: "AAAA", mimeType: "audio/pcm;rate=24000" },
    );
    expect(received[1].serverContent?.outputTranscription?.text).toBe("hola");
    expect(received[2].serverContent?.inputTranscription).toEqual({
      text: "qué hora es",
      finished: true,
    });
    expect(received[3].toolCall?.functionCalls?.[0]).toEqual({
      id: "call_3",
      name: "search_web",
      args: { query: "hora" },
    });
  });

  it("queues a second response instead of losing it mid-sentence", () => {
    // La Realtime API solo admite una respuesta en curso: una notificación que
    // llega mientras habla no puede desaparecer ni provocar un error.
    const { session, sent, types } = createSession();

    session.sendClientContent({ turns: "primera" });
    session.sendClientContent({ turns: "una notificación" });

    expect(types().filter((type) => type === "response.create")).toHaveLength(
      1,
    );

    sent.length = 0;
    session.handleServerEvent(JSON.stringify({ type: "response.done" }));

    expect(types()).toEqual(["response.create"]);
  });

  it("drops the queued response when the user barges in", () => {
    const { session, sent, types } = createSession();

    session.sendClientContent({ turns: "primera" });
    session.sendClientContent({ turns: "una notificación" });
    session.sendRealtimeInput({ activityStart: {} });
    sent.length = 0;
    session.handleServerEvent(
      JSON.stringify({
        type: "response.done",
        response: { status: "cancelled" },
      }),
    );

    expect(types()).toEqual([]);
  });

  it("does not close the turn twice after a cancelled response", () => {
    // Ya se emitió `interrupted`; cerrar el turno otra vez pondría la UI en
    // "escuchando" en mitad del barge-in.
    const { session, received } = createSession();

    session.handleServerEvent(
      JSON.stringify({
        type: "response.done",
        response: { status: "cancelled" },
      }),
    );

    expect(received).toHaveLength(0);
  });

  it("retries once without transcription when the server rejects it", () => {
    // Sin esta degradación, un modelo de transcripción no disponible en la
    // cuenta dejaría la sesión entera sin voz.
    const { session, sent } = createSession();

    session.handleServerEvent(
      JSON.stringify({
        type: "error",
        error: {
          message: "unsupported",
          param: "session.audio.input.transcription",
        },
      }),
    );

    const config = sent.at(-1)?.session as {
      audio: { input: { transcription?: unknown } };
    };
    expect(sent.at(-1)?.type).toBe("session.update");
    expect(config.audio.input.transcription).toBeUndefined();
  });
});

describe("toRealtimeTools", () => {
  it("keeps the functions and drops Google-only grounding", () => {
    const tools = toRealtimeTools([
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: "search_web",
            description: "busca",
            parametersJsonSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
    ]);

    expect(tools).toEqual([
      {
        type: "function",
        name: "search_web",
        description: "busca",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
  });
});

describe("flattenClientTurns", () => {
  it("reads both the string and the Content forms the manager uses", () => {
    expect(flattenClientTurns("hola")).toBe("hola");
    expect(
      flattenClientTurns([{ role: "user", parts: [{ text: "aviso" }] }]),
    ).toBe("aviso");
  });
});

describe("PcmUpsampler", () => {
  it("stretches 16 kHz capture to the 24 kHz the API expects", () => {
    const upsampler = new PcmUpsampler();

    const out = upsampler.process(captureBlock());

    // 640 muestras a 16 kHz son 960 a 24 kHz: los mismos 40 ms.
    expect(out.length >> 1).toBe(960);
  });

  it("keeps phase across blocks so a long turn does not drift", () => {
    const upsampler = new PcmUpsampler();
    let total = 0;

    for (let i = 0; i < 25; i += 1) {
      total += upsampler.process(captureBlock()).length >> 1;
    }

    // Un segundo de captura tiene que seguir siendo un segundo de audio.
    expect(total).toBe(24000);
  });
});
