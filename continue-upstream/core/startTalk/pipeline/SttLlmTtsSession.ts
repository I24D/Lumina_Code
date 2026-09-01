/**
 * La sesión de voz por tuberías, hablando el contrato de la Live API.
 *
 * `StartTalkManager` no sabe que esto no es un modelo de voz a voz: recibe los
 * mismos `LiveServerMessage` que le manda Gemini, así que el gate de voz, el
 * barge-in, las funciones, las métricas y la cancelación funcionan igual. Es la
 * razón de traducir aquí en vez de dar un segundo camino al manager.
 *
 * Lo que sí cambia es de dónde sale la latencia, y de ahí las dos decisiones
 * que gobiernan el archivo:
 *
 *  - Se habla por oraciones, no por respuesta. En cuanto el segmentador cierra
 *    una, se sintetiza y suena mientras el modelo escribe la siguiente. Esperar
 *    a la respuesta entera sumaría el tiempo del LLM y el del TTS en serie.
 *  - Cada turno vive bajo un `AbortController`. Una interrupción tiene que
 *    parar la generación, la síntesis en vuelo y lo que quedara por decir; sin
 *    eso, Lumina sigue hablando sola después de que la corten.
 */
import { Buffer } from "node:buffer";

import type { LiveServerMessage } from "@google/genai";

import { StreamingSentenceSegmenter } from "../speechText.js";
import { flattenClientTurns } from "../VoiceProvider.js";
import type {
  LiveSessionCallbacks,
  LiveSessionHandle,
} from "../VoiceProvider.js";
import {
  VoicePipelineError,
  type LlmRequest,
  type PipelineMessage,
  type PipelineToolCall,
  type VoicePipelineStages,
} from "./types.js";

/** Devolver su resultado sin pedir respuesta es, literalmente, callarse. */
const STAY_SILENT_FUNCTION_NAME = "stay_silent";

/** Lo que entrega `VoiceActivityGate`: PCM s16le mono a 16 kHz. */
const CAPTURE_SAMPLE_RATE = 16_000;

/**
 * Por debajo de esto no hay turno que transcribir. El gate tiene 280 ms de
 * pre-roll, así que solo salta en un turno degenerado (un clic, un corte justo
 * al abrir) y evita pagar una transcripción de ruido.
 */
const MIN_TURN_MS = 200;

/**
 * Cuánta conversación se le recuerda al modelo. La tubería no tiene sesión en
 * el servidor: el historial viaja entero en cada petición, así que sin tope una
 * conversación larga acaba costando más en contexto que en generación.
 */
const MAX_HISTORY_MESSAGES = 40;

export interface VoicePipelineConfig {
  /** System prompt de la sesión. */
  instructions: string;
  /** Voz de salida que se le pide al TTS. */
  voice: string;
  /** Herramientas en formato Live API. */
  tools: LlmRequest["tools"];
  /** Fija el idioma de la transcripción (BCP-47). */
  languageCode?: string;
  /** Qué modelo razona. Sin él manda la configuración del `.env`. */
  llmModel?: string;
}

export class SttLlmTtsSession implements LiveSessionHandle {
  private readonly history: PipelineMessage[] = [];
  private turnAudio: Buffer[] = [];
  private turnAudioBytes = 0;
  private generation?: AbortController;
  private closed = false;

  constructor(
    private readonly stages: VoicePipelineStages,
    private readonly config: VoicePipelineConfig,
    private readonly callbacks: LiveSessionCallbacks,
  ) {}

  /** Anuncia la sesión lista, como hace `setupComplete` en la Live API. */
  start(): void {
    this.deliver({ setupComplete: {} } as LiveServerMessage);
  }

  private deliver(message: LiveServerMessage): void {
    if (!this.closed) {
      this.callbacks.onmessage(message);
    }
  }

  sendRealtimeInput(
    input: Parameters<LiveSessionHandle["sendRealtimeInput"]>[0],
  ): void {
    if (input.activityStart) {
      this.interrupt();
      this.turnAudio = [];
      this.turnAudioBytes = 0;
    }

    if (input.audio?.data) {
      const chunk = Buffer.from(input.audio.data, "base64");
      this.turnAudio.push(chunk);
      this.turnAudioBytes += chunk.length;
    }

    // El vídeo se descarta a propósito: esta tubería declara `vision: false`
    // (ver el adaptador). Aceptarlo en silencio haría creer al manager que
    // Lumina está viendo la pantalla cuando el LLM nunca recibe el fotograma.

    if (input.text) {
      this.sendClientContent({ turns: input.text });
    }

    if (input.activityEnd) {
      void this.runSpokenTurn();
    }
  }

  sendClientContent(
    content: Parameters<LiveSessionHandle["sendClientContent"]>[0],
  ): void {
    const text = flattenClientTurns(content.turns);
    if (text) {
      this.push({ role: "user", content: text });
    }
    // `turnComplete: false` es contexto que no pide voz (avisos de entorno).
    if (content.turnComplete !== false) {
      void this.generate();
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
      this.push({
        role: "tool",
        toolCallId: String(functionResponse.id ?? ""),
        content: JSON.stringify(functionResponse.response ?? {}),
      });
    }

    // Todo resultado se lee en voz alta salvo `stay_silent`, cuyo sentido es
    // justamente gastar el turno sin producir voz.
    const onlySilence = responses.every(
      (functionResponse) => functionResponse.name === STAY_SILENT_FUNCTION_NAME,
    );
    if (onlySilence) {
      this.deliver({
        serverContent: { turnComplete: true },
      } as LiveServerMessage);
      return;
    }
    void this.generate();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.generation?.abort();
    this.generation = undefined;
    this.callbacks.onclose({ code: 1000, reason: "client closed" });
  }

  /** Corta lo que estuviera diciendo: es el barge-in autorizado por el gate. */
  private interrupt(): void {
    if (!this.generation) {
      return;
    }
    this.generation.abort();
    this.generation = undefined;
    this.deliver({ serverContent: { interrupted: true } } as LiveServerMessage);
  }

  private push(message: PipelineMessage): void {
    this.history.push(message);
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_MESSAGES);
    }
  }

  /** Transcribe lo que se acaba de oír y responde a ello. */
  private async runSpokenTurn(): Promise<void> {
    const audio = Buffer.concat(this.turnAudio);
    this.turnAudio = [];
    this.turnAudioBytes = 0;

    const durationMs = (audio.length >> 1) / (CAPTURE_SAMPLE_RATE / 1000);
    if (durationMs < MIN_TURN_MS) {
      return;
    }

    const controller = new AbortController();
    this.generation = controller;

    let heard: string;
    try {
      heard = await this.stages.stt.transcribe(audio, {
        sampleRate: CAPTURE_SAMPLE_RATE,
        languageCode: this.config.languageCode,
        signal: controller.signal,
      });
    } catch (error) {
      this.failTurn(controller, error);
      return;
    }

    if (controller.signal.aborted) {
      return;
    }

    const said = heard.trim();
    if (!said) {
      // Falso positivo del gate: se abrió turno con algo que no era voz. El
      // manager ya lo contabiliza como `falseStart` al no ver transcripción.
      this.generation = undefined;
      this.deliver({
        serverContent: { turnComplete: true },
      } as LiveServerMessage);
      return;
    }

    this.deliver({
      serverContent: { inputTranscription: { text: said, finished: true } },
    } as LiveServerMessage);
    this.push({ role: "user", content: said });
    await this.generate(controller);
  }

  /**
   * Pide la respuesta y la va diciendo por oraciones.
   *
   * `existing` llega cuando el turno hablado ya abrió un controlador para la
   * transcripción: reutilizarlo mantiene todo el turno bajo una sola
   * cancelación, que es lo que hace que una interrupción pare de verdad.
   */
  private async generate(existing?: AbortController): Promise<void> {
    if (this.closed) {
      return;
    }
    const controller = existing ?? new AbortController();
    if (!existing) {
      this.generation?.abort();
      this.generation = controller;
    }

    const segmenter = new StreamingSentenceSegmenter();
    const toolCalls: PipelineToolCall[] = [];
    let spokenText = "";

    try {
      const request: LlmRequest = {
        instructions: this.config.instructions,
        messages: [...this.history],
        tools: this.config.tools,
      };
      for await (const chunk of this.stages.llm.stream(
        request,
        controller.signal,
      )) {
        if (controller.signal.aborted) {
          return;
        }
        if ("toolCall" in chunk) {
          toolCalls.push(chunk.toolCall);
          continue;
        }
        if (!chunk.text) {
          continue;
        }
        spokenText += chunk.text;
        // El texto sale ya, aunque la voz vaya por detrás: la interfaz enseña
        // la respuesta mientras se sintetiza.
        this.deliver({
          serverContent: { outputTranscription: { text: chunk.text } },
        } as LiveServerMessage);
        for (const sentence of segmenter.push(chunk.text)) {
          await this.speak(sentence, controller);
        }
      }

      if (controller.signal.aborted) {
        return;
      }
      for (const sentence of segmenter.flush()) {
        await this.speak(sentence, controller);
      }
    } catch (error) {
      this.failTurn(controller, error);
      return;
    }

    if (controller.signal.aborted) {
      return;
    }

    if (spokenText.trim() || toolCalls.length > 0) {
      this.push({
        role: "assistant",
        content: spokenText.trim(),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }

    if (toolCalls.length > 0) {
      // El turno NO se cierra aquí: el manager ejecutará las funciones y
      // devolverá sus resultados, y esa respuesta es la que acaba el turno.
      this.deliver({
        toolCall: {
          functionCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.args,
          })),
        },
      } as LiveServerMessage);
      return;
    }

    this.generation = undefined;
    this.deliver({ serverContent: { turnComplete: true } } as LiveServerMessage);
  }

  /** Sintetiza una oración y la entrega como audio del modelo. */
  private async speak(
    sentence: string,
    controller: AbortController,
  ): Promise<void> {
    const text = sentence.trim();
    if (!text || controller.signal.aborted) {
      return;
    }
    const { pcm, sampleRate } = await this.stages.tts.synthesize(text, {
      voice: this.config.voice,
      signal: controller.signal,
    });
    if (controller.signal.aborted || pcm.length === 0) {
      return;
    }
    this.deliver({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: pcm.toString("base64"),
                mimeType: `audio/pcm;rate=${sampleRate}`,
              },
            },
          ],
        },
      },
    } as LiveServerMessage);
  }

  /**
   * Un turno que no se pudo completar. Solo un fallo fatal —credenciales,
   * configuración— sube a `onerror`, que es el camino por el que el manager
   * reconecta y activa el proveedor de reserva. Lo demás cierra el turno y deja
   * la conversación viva.
   */
  private failTurn(controller: AbortController, error: unknown): void {
    if (this.generation === controller) {
      this.generation = undefined;
    }
    if (controller.signal.aborted) {
      return;
    }
    this.deliver({ serverContent: { turnComplete: true } } as LiveServerMessage);
    if (error instanceof VoicePipelineError && error.fatal) {
      this.callbacks.onerror({ message: error.message });
    }
  }
}
