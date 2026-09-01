/**
 * Backend de voz de OpenAI para Start Talk (Realtime API sobre WebSocket).
 *
 * Habla el mismo contrato que la sesión de Gemini Live (ver `VoiceProvider.ts`)
 * para que `StartTalkManager` gobierne los dos proveedores con un solo camino:
 * aquí se traducen las llamadas del manager a eventos de cliente de la Realtime
 * API, y los eventos del servidor a la forma `LiveServerMessage` que el manager
 * ya sabe despachar. Así el VAD propio, el vídeo, las funciones, las métricas y
 * la reconexión funcionan igual con OpenAI sin duplicar nada.
 *
 * Decisiones que no son evidentes leyendo el protocolo:
 *
 *  - La VAD del servidor va DESACTIVADA (`turn_detection: null`). Quien abre y
 *    cierra el turno es `VoiceActivityGate`, igual que en Gemini; sin esto el
 *    eco de la propia voz de Lumina y las muletillas cortas la interrumpirían.
 *  - El micrófono llega a 16 kHz y la Realtime API toma PCM a 24 kHz, así que
 *    el audio se remuestrea aquí, con continuidad entre bloques.
 *  - `stay_silent` no dispara `response.create`: devolver su resultado sin
 *    pedir respuesta ES el hecho de callarse.
 */
import { Buffer } from "node:buffer";

import type { LiveServerMessage, Tool } from "@google/genai";
import { WebSocket } from "ws";

import type { StartTalkThinkingLevel } from "./types.js";
import type {
  LiveSessionCallbacks,
  LiveSessionHandle,
} from "./VoiceProvider.js";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** Lo que entrega `VoiceActivityGate`: PCM s16le mono a 16 kHz. */
const CAPTURE_SAMPLE_RATE = 16_000;
/** Lo que acepta y devuelve la Realtime API como PCM. */
const WIRE_SAMPLE_RATE = 24_000;
const OUTPUT_MIME = `audio/pcm;rate=${WIRE_SAMPLE_RATE}`;

/**
 * La API rechaza un `input_audio_buffer.commit` con menos de 100 ms de audio.
 * El gate tiene 280 ms de pre-roll, así que esto solo salta en un turno
 * degenerado (un clic, un corte justo al abrir) y evita un error inútil.
 */
const MIN_COMMIT_MS = 120;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

/** Devolver su resultado sin pedir respuesta es, literalmente, callarse. */
const STAY_SILENT_FUNCTION_NAME = "stay_silent";

/**
 * Transcripción de la entrada. `gpt-live-transcribe` transcribe mientras se
 * habla; se puede fijar otro con `START_TALK_OPENAI_TRANSCRIBE_MODEL`.
 */
function transcriptionModel(): string {
  return (
    process.env.START_TALK_OPENAI_TRANSCRIBE_MODEL?.trim() ||
    "gpt-live-transcribe"
  );
}

export interface OpenAIRealtimeConfig {
  /** System prompt de la sesión. */
  instructions: string;
  /** Voz de salida (ver `voices.ts`). */
  voice: string;
  /** Esfuerzo de razonamiento; se mapea 1:1 con `reasoning.effort`. */
  thinkingLevel: StartTalkThinkingLevel;
  /** Herramientas en formato Live API; aquí se convierten a funciones. */
  tools: Tool[];
  /** Fija el idioma de la transcripción de entrada (BCP-47). */
  languageCode?: string;
}

interface RealtimeFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Lo que la sesión necesita del socket. Se declara en vez de depender de la
 * clase de `ws` para poder ejercitar la traducción de eventos con un doble.
 */
export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** `WebSocket.OPEN`, sin arrastrar la clase a los tests. */
const SOCKET_OPEN = 1;

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** Paso del remuestreo como fracción exacta (16 kHz → 24 kHz es 2/3). */
const RATE_GCD = greatestCommonDivisor(CAPTURE_SAMPLE_RATE, WIRE_SAMPLE_RATE);
const STEP_NUM = CAPTURE_SAMPLE_RATE / RATE_GCD;
const STEP_DEN = WIRE_SAMPLE_RATE / RATE_GCD;

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string; code?: string; param?: string };
  response?: { status?: string };
};

/**
 * Convierte el set de tools de la Live API al de la Realtime API. El grounding
 * nativo de Google (`googleSearch`) no existe en OpenAI y se descarta: la
 * búsqueda llega por la función `search_web`, que `buildLiveTools` ya añade
 * cuando el proveedor no tiene grounding propio.
 */
export function toRealtimeTools(tools: Tool[]): RealtimeFunctionTool[] {
  return tools
    .flatMap((tool) => tool.functionDeclarations ?? [])
    .flatMap((declaration) => {
      if (!declaration.name) {
        return [];
      }
      const parameters =
        (declaration.parametersJsonSchema as
          | Record<string, unknown>
          | undefined) ??
        (declaration.parameters as Record<string, unknown> | undefined) ??
        {};
      return [
        {
          type: "function" as const,
          name: declaration.name,
          ...(declaration.description
            ? { description: declaration.description }
            : {}),
          parameters: {
            type: "object",
            properties: {},
            ...parameters,
          },
        },
      ];
    });
}

/** Extrae el texto de lo que el manager manda por `sendClientContent`. */
export function flattenClientTurns(turns: unknown): string {
  if (typeof turns === "string") {
    return turns;
  }
  if (Array.isArray(turns)) {
    return turns
      .map((turn) => flattenClientTurns(turn))
      .filter(Boolean)
      .join("\n");
  }
  if (turns && typeof turns === "object") {
    const parts = (turns as { parts?: Array<{ text?: string }> }).parts;
    if (Array.isArray(parts)) {
      return parts
        .map((part) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
    }
    const text = (turns as { text?: string }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

/**
 * Remuestrea PCM s16le mono de 16 kHz a 24 kHz con interpolación lineal,
 * conservando fase y última muestra entre bloques para no meter un clic cada
 * 40 ms. Se exporta para poder fijar el comportamiento con tests.
 */
export class PcmUpsampler {
  /**
   * Posición de la próxima muestra de salida, en unidades de 1/STEP_DEN de
   * muestra de entrada. Es entera a propósito: acumular el paso en coma
   * flotante deriva y acaba emitiendo una muestra de más por bloque, que en un
   * turno largo se convierte en audio desincronizado.
   */
  private phase = 0;
  private tail = 0;

  reset(): void {
    this.phase = 0;
    this.tail = 0;
  }

  process(chunk: Buffer): Buffer {
    const inputSamples = chunk.length >> 1;
    if (inputSamples === 0) {
      return Buffer.alloc(0);
    }

    // Secuencia virtual [tail, chunk[0..n-1]]: el índice 0 es la última
    // muestra del bloque anterior, así la interpolación cruza el corte.
    const sampleAt = (index: number): number =>
      index <= 0 ? this.tail : chunk.readInt16LE((index - 1) * 2);

    const limit = inputSamples * STEP_DEN;
    const output: number[] = [];
    let position = this.phase;
    while (position < limit) {
      const index = Math.floor(position / STEP_DEN);
      const fraction = (position % STEP_DEN) / STEP_DEN;
      const value =
        sampleAt(index) * (1 - fraction) + sampleAt(index + 1) * fraction;
      output.push(Math.max(-32768, Math.min(32767, Math.round(value))));
      position += STEP_NUM;
    }

    this.phase = position - limit;
    this.tail = chunk.readInt16LE((inputSamples - 1) * 2);

    const buffer = Buffer.alloc(output.length * 2);
    for (let i = 0; i < output.length; i += 1) {
      buffer.writeInt16LE(output[i], i * 2);
    }
    return buffer;
  }
}

export class OpenAIRealtimeSession implements LiveSessionHandle {
  private readonly upsampler = new PcmUpsampler();
  private appendedMs = 0;
  private closed = false;
  private responseActive = false;
  /** Hay una respuesta pedida esperando a que termine la que está sonando. */
  private pendingResponse = false;
  private setupAnnounced = false;
  /** Se degradó ya la transcripción tras un rechazo del servidor. */
  private transcriptionDisabled = false;

  constructor(
    private readonly socket: RealtimeSocket,
    private readonly model: string,
    private readonly config: OpenAIRealtimeConfig,
    private readonly callbacks: LiveSessionCallbacks,
  ) {}

  /** Configuración de sesión; se reenvía degradada si el servidor la rechaza. */
  sessionConfig(): Record<string, unknown> {
    return {
      type: "realtime",
      model: this.model,
      instructions: this.config.instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: WIRE_SAMPLE_RATE },
          // El turno lo abre y lo cierra VoiceActivityGate, no el servidor.
          turn_detection: null,
          ...(this.transcriptionDisabled
            ? {}
            : {
                transcription: {
                  model: transcriptionModel(),
                  ...(this.config.languageCode
                    ? { language: this.config.languageCode.split("-")[0] }
                    : {}),
                },
              }),
        },
        output: {
          format: { type: "audio/pcm", rate: WIRE_SAMPLE_RATE },
          voice: this.config.voice,
        },
      },
      reasoning: { effort: this.config.thinkingLevel },
      tools: toRealtimeTools(this.config.tools),
      tool_choice: "auto",
    };
  }

  configure(): void {
    this.send({ type: "session.update", session: this.sessionConfig() });
  }

  private send(event: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(event));
  }

  private deliver(message: LiveServerMessage): void {
    this.callbacks.onmessage(message);
  }

  /** Corta la respuesta en curso: es el barge-in autorizado por el gate. */
  private cancelActiveResponse(): void {
    if (!this.responseActive) {
      return;
    }
    this.responseActive = false;
    // El usuario cortó: lo que estuviera encolado ya no es lo que quiere oír.
    this.pendingResponse = false;
    this.send({ type: "response.cancel" });
    this.deliver({ serverContent: { interrupted: true } } as LiveServerMessage);
  }

  /**
   * La Realtime API solo admite UNA respuesta en curso. Pedir otra mientras
   * habla la rechaza con `conversation_already_has_active_response`, así que
   * una notificación o un resultado de función que llega a media frase se
   * encola en vez de perderse.
   */
  private requestResponse(): void {
    if (this.responseActive) {
      this.pendingResponse = true;
      return;
    }
    this.responseActive = true;
    this.send({ type: "response.create" });
  }

  private flushPendingResponse(): void {
    if (!this.pendingResponse) {
      return;
    }
    this.pendingResponse = false;
    this.requestResponse();
  }

  sendRealtimeInput(
    input: Parameters<LiveSessionHandle["sendRealtimeInput"]>[0],
  ): void {
    if (input.activityStart) {
      this.cancelActiveResponse();
      this.upsampler.reset();
      this.appendedMs = 0;
      this.send({ type: "input_audio_buffer.clear" });
    }

    if (input.audio?.data) {
      const pcm = this.upsampler.process(
        Buffer.from(input.audio.data, "base64"),
      );
      if (pcm.length > 0) {
        this.appendedMs += (pcm.length >> 1) / (WIRE_SAMPLE_RATE / 1000);
        this.send({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        });
      }
    }

    if (input.video?.data) {
      // Los ojos de Lumina: un fotograma entra como contenido del usuario, sin
      // pedir respuesta. Quien decide cuándo hablar sigue siendo el turno de voz.
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${input.video.mimeType ?? "image/jpeg"};base64,${input.video.data}`,
            },
          ],
        },
      });
    }

    if (input.text) {
      this.sendClientContent({ turns: input.text });
    }

    if (input.activityEnd) {
      if (this.appendedMs >= MIN_COMMIT_MS) {
        this.send({ type: "input_audio_buffer.commit" });
        this.requestResponse();
      } else {
        // Turno demasiado corto para que la API lo acepte: se descarta en vez
        // de provocar un `input_audio_buffer_commit_empty`.
        this.send({ type: "input_audio_buffer.clear" });
      }
      this.appendedMs = 0;
    }
  }

  sendClientContent(
    content: Parameters<LiveSessionHandle["sendClientContent"]>[0],
  ): void {
    const text = flattenClientTurns(content.turns);
    if (text) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    }

    // `turnComplete: false` es contexto que no pide voz (avisos de entorno).
    if (content.turnComplete !== false) {
      this.requestResponse();
    }
  }

  sendToolResponse(
    response: Parameters<LiveSessionHandle["sendToolResponse"]>[0],
  ): void {
    const responses = Array.isArray(response.functionResponses)
      ? response.functionResponses
      : response.functionResponses
        ? [response.functionResponses]
        : [];
    if (responses.length === 0) {
      return;
    }

    for (const functionResponse of responses) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionResponse.id,
          output: JSON.stringify(functionResponse.response ?? {}),
        },
      });
    }

    // Todo resultado se lee en voz alta salvo `stay_silent`, cuyo sentido es
    // justamente gastar el turno sin producir voz.
    const onlySilence = responses.every(
      (functionResponse) => functionResponse.name === STAY_SILENT_FUNCTION_NAME,
    );
    if (!onlySilence) {
      this.requestResponse();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.close(1000, "client closed");
    } catch {
      // El socket pudo caerse solo; el onclose ya habrá corrido.
    }
  }

  handleServerEvent(raw: string): void {
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(raw) as RealtimeServerEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "session.updated":
      case "session.created": {
        if (!this.setupAnnounced) {
          this.setupAnnounced = true;
          this.deliver({ setupComplete: {} } as LiveServerMessage);
        }
        return;
      }

      case "response.created": {
        this.responseActive = true;
        return;
      }

      // La API GA emite `response.output_audio.*`; se acepta también el nombre
      // anterior para no depender de la versión que sirva la cuenta.
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (!event.delta) {
          return;
        }
        this.deliver({
          serverContent: {
            modelTurn: {
              parts: [
                { inlineData: { data: event.delta, mimeType: OUTPUT_MIME } },
              ],
            },
          },
        } as LiveServerMessage);
        return;
      }

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (!event.delta) {
          return;
        }
        this.deliver({
          serverContent: { outputTranscription: { text: event.delta } },
        } as LiveServerMessage);
        return;
      }

      case "conversation.item.input_audio_transcription.delta": {
        if (!event.delta) {
          return;
        }
        this.deliver({
          serverContent: { interimInputTranscription: { text: event.delta } },
        } as LiveServerMessage);
        return;
      }

      case "conversation.item.input_audio_transcription.completed": {
        if (!event.transcript) {
          return;
        }
        this.deliver({
          serverContent: {
            inputTranscription: { text: event.transcript, finished: true },
          },
        } as LiveServerMessage);
        return;
      }

      case "response.function_call_arguments.done": {
        if (!event.name || !event.call_id) {
          return;
        }
        this.deliver({
          toolCall: {
            functionCalls: [
              {
                id: event.call_id,
                name: event.name,
                args: parseFunctionArgs(event.arguments),
              },
            ],
          },
        } as LiveServerMessage);
        return;
      }

      case "response.done": {
        this.responseActive = false;
        const cancelled = event.response?.status === "cancelled";
        this.flushPendingResponse();
        if (cancelled) {
          // Ya se emitió `interrupted` al cancelar; cerrar el turno otra vez
          // haría que la UI pasara por "escuchando" en mitad del barge-in.
          return;
        }
        this.deliver({
          serverContent: { turnComplete: true },
        } as LiveServerMessage);
        return;
      }

      case "error": {
        this.handleServerError(event);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Un rechazo de la configuración de transcripción dejaría la sesión sin voz
   * entera. Se degrada una vez —sin transcripción de entrada— y se reintenta,
   * igual que el manager degrada la búsqueda antes de darse por vencido.
   */
  private handleServerError(event: RealtimeServerEvent): void {
    const message = event.error?.message ?? "OpenAI Realtime error.";
    const param = event.error?.param ?? "";
    const code = event.error?.code ?? "";

    if (!this.transcriptionDisabled && param.includes("transcription")) {
      this.transcriptionDisabled = true;
      this.configure();
      return;
    }

    // Carrera contra una cancelación que el servidor aún no había cerrado. No
    // es un fallo de conexión: se reintenta al terminar el turno en curso, y
    // marcar la sesión como caída aquí provocaría una reconexión inútil.
    if (code === "conversation_already_has_active_response") {
      this.pendingResponse = true;
      return;
    }

    this.callbacks.onerror({ message });
  }
}

function parseFunctionArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Abre una sesión de la Realtime API. Resuelve cuando el socket está abierto y
 * la configuración enviada, con la misma forma que `ai.live.connect`, para que
 * el manager trate los dos proveedores igual.
 */
export function connectOpenAIRealtime({
  apiKey,
  model,
  config,
  callbacks,
}: {
  apiKey: string;
  model: string;
  config: OpenAIRealtimeConfig;
  callbacks: LiveSessionCallbacks;
}): Promise<LiveSessionHandle> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${REALTIME_URL}?model=${encodeURIComponent(model)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const session = new OpenAIRealtimeSession(socket, model, config, callbacks);
    let settled = false;
    let lastPongAt = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stopHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };

    socket.on("open", () => {
      settled = true;
      session.configure();
      callbacks.onopen();
      heartbeat = setInterval(() => {
        if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          socket.terminate();
          return;
        }
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      resolve(session);
    });

    socket.on("pong", () => {
      lastPongAt = Date.now();
    });

    socket.on("message", (data) => {
      session.handleServerEvent(data.toString());
    });

    socket.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `OpenAI Realtime connection failed: ${error.message || "unknown error"}`,
          ),
        );
        return;
      }
      callbacks.onerror({
        message: error.message || "OpenAI Realtime connection failed.",
      });
    });

    socket.on("close", (code: number, reason: Buffer) => {
      stopHeartbeat();
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `OpenAI Realtime closed before setup (${code}). ${reason.toString()}`.trim(),
          ),
        );
        return;
      }
      callbacks.onclose({ code, reason: reason.toString() || undefined });
    });
  });
}
