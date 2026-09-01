import { Buffer } from "node:buffer";

import type { LiveServerMessage } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

import {
  SseDecoder,
  pcmToWav,
  toOpenAiMessages,
  toOpenAiTools,
} from "./openAiStages.js";
import { SttLlmTtsSession } from "./SttLlmTtsSession.js";
import {
  VoicePipelineError,
  type LlmChunk,
  type VoicePipelineStages,
} from "./types.js";

/** 400 ms de silencio: suficiente para que el turno no se descarte por corto. */
function turnAudio(ms = 400): string {
  return Buffer.alloc(16_000 * 2 * (ms / 1000)).toString("base64");
}

function harness(
  chunks: LlmChunk[],
  overrides: Partial<VoicePipelineStages> = {},
) {
  const received: LiveServerMessage[] = [];
  const errors: string[] = [];
  const spoken: string[] = [];

  const stages: VoicePipelineStages = {
    stt: {
      id: "fake-stt",
      transcribe: vi.fn(async () => "busca el precio del oro"),
    },
    llm: {
      id: "fake-llm",
      // eslint-disable-next-line require-yield
      stream: vi.fn(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      }),
    },
    tts: {
      id: "fake-tts",
      synthesize: vi.fn(async (text: string) => {
        spoken.push(text);
        return { pcm: Buffer.alloc(48), sampleRate: 24_000 };
      }),
    },
    ...overrides,
  };

  const session = new SttLlmTtsSession(
    stages,
    { instructions: "eres Lumina", voice: "sage", tools: [] },
    {
      onopen: () => undefined,
      onmessage: (message) => received.push(message),
      onerror: ({ message }) => errors.push(message),
      onclose: () => undefined,
    },
  );

  return { session, stages, received, errors, spoken };
}

const audioParts = (received: LiveServerMessage[]) =>
  received.filter((m) => m.serverContent?.modelTurn?.parts?.length);

describe("SttLlmTtsSession", () => {
  it("oye, piensa y habla por oraciones", async () => {
    const { session, received, spoken } = harness([
      { text: "El oro sube hoy. " },
      { text: "Cerró en dos mil euros." },
    ]);

    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: { data: turnAudio(), mimeType: "audio/pcm;rate=16000" },
    });
    session.sendRealtimeInput({ activityEnd: {} });
    await vi.waitFor(() =>
      expect(received.at(-1)?.serverContent?.turnComplete).toBe(true),
    );

    // La transcripción del usuario entra como la de cualquier proveedor.
    expect(received[0]?.serverContent?.inputTranscription?.text).toBe(
      "busca el precio del oro",
    );
    // Dos oraciones, dos síntesis: la primera suena mientras llega la segunda.
    expect(spoken).toEqual(["El oro sube hoy.", "Cerró en dos mil euros."]);
    expect(audioParts(received)).toHaveLength(2);
  });

  it("no transcribe un turno demasiado corto", async () => {
    const { session, stages, received } = harness([{ text: "hola" }]);

    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: { data: turnAudio(60), mimeType: "audio/pcm;rate=16000" },
    });
    session.sendRealtimeInput({ activityEnd: {} });
    await new Promise((done) => setTimeout(done, 10));

    expect(stages.stt.transcribe).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("entrega las llamadas a función sin cerrar el turno", async () => {
    const { session, received } = harness([
      { text: "Voy a mirarlo. " },
      {
        toolCall: { id: "call_1", name: "search_web", args: { query: "oro" } },
      },
    ]);

    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: { data: turnAudio(), mimeType: "audio/pcm;rate=16000" },
    });
    session.sendRealtimeInput({ activityEnd: {} });
    await vi.waitFor(() =>
      expect(received.some((m) => m.toolCall?.functionCalls?.length)).toBe(true),
    );

    // El turno lo cierra la respuesta a la función, no la propuesta.
    expect(received.some((m) => m.serverContent?.turnComplete)).toBe(false);
    expect(received.at(-1)?.toolCall?.functionCalls?.[0]?.name).toBe(
      "search_web",
    );
  });

  it("`stay_silent` gasta el turno sin hablar", async () => {
    const { session, stages, received } = harness([]);

    session.sendToolResponse({
      functionResponses: [{ id: "c1", name: "stay_silent", response: {} }],
    });
    await new Promise((done) => setTimeout(done, 10));

    expect(stages.llm.stream).not.toHaveBeenCalled();
    expect(stages.tts.synthesize).not.toHaveBeenCalled();
    expect(received.at(-1)?.serverContent?.turnComplete).toBe(true);
  });

  it("una interrupción calla lo que quedaba por decir", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const { session, received, spoken } = harness([], {
      llm: {
        id: "slow-llm",
        stream: async function* () {
          yield { text: "Primera oración. " };
          await gate;
          yield { text: "Segunda oración." };
        },
      },
    });

    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: { data: turnAudio(), mimeType: "audio/pcm;rate=16000" },
    });
    session.sendRealtimeInput({ activityEnd: {} });
    await vi.waitFor(() => expect(spoken).toHaveLength(1));

    // El usuario vuelve a hablar: barge-in.
    session.sendRealtimeInput({ activityStart: {} });
    release();
    await new Promise((done) => setTimeout(done, 10));

    expect(received.some((m) => m.serverContent?.interrupted)).toBe(true);
    // La segunda oración ya no se sintetiza ni suena.
    expect(spoken).toEqual(["Primera oración."]);
    expect(received.some((m) => m.serverContent?.turnComplete)).toBe(false);
  });

  it("un fallo pasajero cierra el turno y deja viva la conversación", async () => {
    const { session, received, errors } = harness([], {
      llm: {
        id: "flaky",
        stream: async function* (): AsyncGenerator<LlmChunk> {
          throw new VoicePipelineError("timeout");
        },
      },
    });

    session.sendClientContent({ turns: "hola" });
    await vi.waitFor(() =>
      expect(received.at(-1)?.serverContent?.turnComplete).toBe(true),
    );
    expect(errors).toEqual([]);
  });

  it("un fallo de credenciales sí sube, para que entre el proveedor de reserva", async () => {
    const { session, errors } = harness([], {
      llm: {
        id: "unauthorized",
        stream: async function* (): AsyncGenerator<LlmChunk> {
          throw new VoicePipelineError("OPENAI_API_KEY is not configured.", true);
        },
      },
    });

    session.sendClientContent({ turns: "hola" });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toContain("OPENAI_API_KEY");
  });

  it("el contexto que no pide voz no genera respuesta", async () => {
    const { session, stages } = harness([{ text: "hola" }]);

    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "[aviso del sistema]" }] }],
      turnComplete: false,
    });
    await new Promise((done) => setTimeout(done, 10));

    expect(stages.llm.stream).not.toHaveBeenCalled();
  });
});

describe("traducción al formato de OpenAI", () => {
  it("envuelve el PCM en un WAV que el servidor sabe leer", () => {
    const wav = pcmToWav(Buffer.alloc(32), 16_000);

    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(32);
    expect(wav.length).toBe(76);
  });

  it("descarta el grounding de Google y conserva las funciones", () => {
    const tools = toOpenAiTools([
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: "search_web",
            description: "busca",
            parametersJsonSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ],
      },
    ]);

    expect(tools).toHaveLength(1);
    expect((tools[0] as { function: { name: string } }).function.name).toBe(
      "search_web",
    );
  });

  it("conserva el hilo de una llamada a función y su resultado", () => {
    const messages = toOpenAiMessages({
      instructions: "eres Lumina",
      tools: [],
      messages: [
        { role: "user", content: "busca el oro" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "search_web", args: { query: "oro" } }],
        },
        { role: "tool", toolCallId: "c1", content: '{"sources":[]}' },
      ],
    });

    expect(messages[0]).toEqual({ role: "system", content: "eres Lumina" });
    // Sin `tool_call_id` el servidor rechaza el mensaje de resultado.
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(
      (messages[2] as { tool_calls: Array<{ id: string }> }).tool_calls[0].id,
    ).toBe("c1");
  });
});

describe("SseDecoder", () => {
  it("junta un evento partido entre dos chunks de red", () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"a":')).toEqual([]);
    expect(decoder.push('1}\ndata: [DONE]\n')).toEqual(['{"a":1}']);
  });

  it("ignora los comentarios de keep-alive", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(": ping\n\n")).toEqual([]);
  });
});
