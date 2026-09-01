/**
 * El contrato de la voz por tuberías: oír, pensar, hablar como tres piezas
 * separadas (STT → LLM → TTS) en vez de un solo modelo de voz a voz.
 *
 * Existe porque las dos arquitecturas ganan en cosas distintas. La nativa
 * (Gemini Live, OpenAI Realtime) conserva prosodia y ritmo, y responde antes.
 * La modular deja elegir quién oye, quién razona y quién habla —un modelo local
 * pensando y una voz de pago hablando, o al revés—, deja ver el texto entre
 * etapa y etapa, y sobrevive a que un proveedor deje de ofrecer voz nativa.
 *
 * Cada etapa se declara aquí y se inyecta, así que la orquestación se puede
 * probar entera sin red.
 */
import type { Tool } from "@google/genai";

/** Un turno ya cerrado dentro de la conversación de la tubería. */
export interface PipelineMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Presente en `role: "tool"`: a qué llamada responde. */
  toolCallId?: string;
  /** Presente en `role: "assistant"`: qué llamó antes de callarse. */
  toolCalls?: PipelineToolCall[];
}

export interface PipelineToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmRequest {
  instructions: string;
  messages: readonly PipelineMessage[];
  tools: readonly Tool[];
}

/**
 * Un trozo de generación. El texto llega palabra a palabra para poder empezar a
 * hablar antes de que el modelo termine; las llamadas a función llegan enteras
 * porque ejecutar media llamada no significa nada.
 */
export type LlmChunk = { text: string } | { toolCall: PipelineToolCall };

export interface SttStage {
  /** Identificador legible; aparece en los diagnósticos de la sesión. */
  id: string;
  transcribe(
    pcm: Buffer,
    options: { sampleRate: number; languageCode?: string; signal: AbortSignal },
  ): Promise<string>;
}

export interface LlmStage {
  id: string;
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk>;
}

export interface TtsStage {
  id: string;
  synthesize(
    text: string,
    options: { voice: string; signal: AbortSignal },
  ): Promise<{ pcm: Buffer; sampleRate: number }>;
}

export interface VoicePipelineStages {
  stt: SttStage;
  llm: LlmStage;
  tts: TtsStage;
}

/**
 * Un fallo de la tubería.
 *
 * `fatal` separa lo que rompe la sesión de lo que solo estropea un turno, y esa
 * distinción decide el comportamiento: una clave inválida tiene que llegar a
 * `onerror` para que el manager active el proveedor de reserva, mientras que un
 * timeout suelto solo debe cerrar el turno. Tratar todo como fatal provocaría
 * reconexiones en bucle por un corte de red de dos segundos.
 */
export class VoicePipelineError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "VoicePipelineError";
  }
}
