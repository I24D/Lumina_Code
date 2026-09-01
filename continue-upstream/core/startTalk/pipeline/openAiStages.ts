/**
 * Las tres etapas de la tubería sobre HTTP, en la forma de OpenAI.
 *
 * Se eligió esa forma porque es la que hablan casi todos: Ollama Cloud, Kimi,
 * Zhipu y cualquier gateway compatible exponen `/v1/chat/completions` igual, así
 * que cambiar de cerebro es cambiar una URL base y un modelo en el `.env` en vez
 * de escribir un cliente nuevo. Eso es lo que convierte esta tubería en el
 * enrutador de modelos: quien oye, quien razona y quien habla se configuran por
 * separado.
 *
 * Todo lo que se puede configurar sale de `readLuminaEnv`, no de `process.env`
 * a secas: el `.env` de la raíz se parsea a una caché propia y nunca se inyecta
 * en el entorno del proceso.
 */
import { Buffer } from "node:buffer";

import type { Tool } from "@google/genai";

import { readLuminaEnv } from "../../luminaBridge/luminaEnv.js";
import {
  VoicePipelineError,
  type LlmChunk,
  type LlmRequest,
  type LlmStage,
  type SttStage,
  type TtsStage,
  type VoicePipelineStages,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** El TTS de OpenAI entrega PCM s16le mono a 24 kHz con `response_format: pcm`. */
const TTS_SAMPLE_RATE = 24_000;

function env(name: string): string | undefined {
  const value = readLuminaEnv(name)?.trim();
  return value ? value : undefined;
}

function baseUrl(specific: string): string {
  return (env(specific) ?? env("OPENAI_BASE_URL") ?? DEFAULT_BASE_URL).replace(
    /\/+$/u,
    "",
  );
}

function requireKey(name: string): string {
  const key = env(name) ?? env("OPENAI_API_KEY");
  if (!key) {
    // Fatal: sin clave no hay turno que valga, y el manager tiene que poder
    // caer al proveedor de reserva en vez de reintentar en bucle.
    throw new VoicePipelineError(`${name} is not configured.`, true);
  }
  return key;
}

/** Un fallo HTTP. 401/403/404 son de configuración: no se arreglan solos. */
async function failFor(
  stage: string,
  response: { status: number; text(): Promise<string> },
): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  const fatal = [401, 403, 404].includes(response.status);
  throw new VoicePipelineError(
    `${stage} failed (${response.status}). ${detail}`.trim(),
    fatal,
  );
}

/**
 * Envuelve PCM s16le mono en un WAV mínimo.
 *
 * Los endpoints de transcripción reconocen el formato por la cabecera del
 * archivo, no por su extensión: mandar PCM crudo se rechaza como formato no
 * soportado aunque el audio sea perfectamente válido.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // tamaño del bloque fmt
  header.writeUInt16LE(1, 20); // PCM sin comprimir
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // alineación de bloque
  header.writeUInt16LE(16, 34); // bits por muestra
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Convierte las tools de la Live API a la forma de OpenAI. El grounding nativo
 * de Google no existe aquí y se descarta: la búsqueda llega por `search_web`,
 * que `buildLiveTools` añade cuando el proveedor no tiene grounding propio.
 */
export function toOpenAiTools(
  tools: readonly Tool[],
): Array<Record<string, unknown>> {
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
          type: "function",
          function: {
            name: declaration.name,
            ...(declaration.description
              ? { description: declaration.description }
              : {}),
            parameters: { type: "object", properties: {}, ...parameters },
          },
        },
      ];
    });
}

/** Traduce el historial de la tubería al formato de mensajes de OpenAI. */
export function toOpenAiMessages(
  request: LlmRequest,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: request.instructions },
  ];
  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        })),
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

/**
 * Trocea un cuerpo SSE en eventos `data:`.
 *
 * Un chunk de red no respeta los límites de los eventos: parte una línea por la
 * mitad tan a menudo como no. El resto se guarda hasta que llegue lo que falta.
 */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          events.push(payload);
        }
      }
      index = this.buffer.indexOf("\n");
    }
    return events;
  }
}

interface StreamDelta {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/**
 * Acumula las llamadas a función que llegan troceadas.
 *
 * OpenAI manda los argumentos de una llamada repartidos en varios deltas y solo
 * identifica cada una por su índice: sin acumular por índice se acabaría
 * ejecutando una función con el JSON a medias.
 */
class ToolCallAccumulator {
  private readonly calls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  push(
    delta: NonNullable<
      NonNullable<StreamDelta["choices"]>[number]["delta"]
    >["tool_calls"],
  ): void {
    for (const entry of delta ?? []) {
      const index = entry.index ?? 0;
      const current = this.calls.get(index) ?? { id: "", name: "", args: "" };
      this.calls.set(index, {
        id: entry.id || current.id,
        name: entry.function?.name || current.name,
        args: current.args + (entry.function?.arguments ?? ""),
      });
    }
  }

  drain(): LlmChunk[] {
    const chunks: LlmChunk[] = [];
    for (const [index, call] of this.calls) {
      if (!call.name) {
        continue;
      }
      chunks.push({
        toolCall: {
          id: call.id || `call_${index}`,
          name: call.name,
          args: parseArgs(call.args),
        },
      });
    }
    this.calls.clear();
    return chunks;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
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

/** Transcripción por HTTP (`/audio/transcriptions`). */
export function createOpenAiStt(): SttStage {
  const model =
    env("START_TALK_PIPELINE_STT_MODEL") ??
    env("OPENAI_AUDIO_TRANSCRIPTION_MODEL") ??
    "whisper-1";
  return {
    id: `openai:${model}`,
    async transcribe(pcm, { sampleRate, languageCode, signal }) {
      const form = new FormData();
      const wav = pcmToWav(pcm, sampleRate);
      form.append(
        "file",
        new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
        "turn.wav",
      );
      form.append("model", model);
      if (languageCode) {
        form.append("language", languageCode.split("-")[0]);
      }

      const response = await fetch(
        `${baseUrl("START_TALK_PIPELINE_STT_BASE_URL")}/audio/transcriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${requireKey("START_TALK_PIPELINE_STT_KEY")}`,
          },
          body: form,
          signal,
        },
      );
      if (!response.ok) {
        await failFor("Speech-to-text", response);
      }
      const data = (await response.json()) as { text?: string };
      return String(data.text ?? "");
    },
  };
}

/**
 * Generación en streaming (`/chat/completions`).
 *
 * `requested` es el modelo que eligió el usuario en la interfaz. Manda sobre el
 * `.env`: si eliges un cerebro en el orbe y la variable de entorno lo ignorara,
 * la elección no significaría nada.
 */
export function createOpenAiLlm(requested?: string): LlmStage {
  const model =
    requested?.trim() ||
    env("START_TALK_PIPELINE_LLM_MODEL") ||
    env("OPENAI_MODEL") ||
    "gpt-5-mini";
  return {
    id: `openai:${model}`,
    async *stream(request, signal) {
      const tools = toOpenAiTools(request.tools);
      const response = await fetch(
        `${baseUrl("START_TALK_PIPELINE_LLM_BASE_URL")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requireKey("START_TALK_PIPELINE_LLM_KEY")}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            messages: toOpenAiMessages(request),
            ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          }),
          signal,
        },
      );
      if (!response.ok || !response.body) {
        await failFor("Language model", response);
      }

      const decoder = new SseDecoder();
      const textDecoder = new TextDecoder();
      const toolCalls = new ToolCallAccumulator();
      // @ts-expect-error el cuerpo de fetch es un stream asíncrono iterable en Node
      for await (const raw of response.body) {
        if (signal.aborted) {
          return;
        }
        const chunk = textDecoder.decode(raw as Uint8Array, { stream: true });
        for (const event of decoder.push(chunk)) {
          let parsed: StreamDelta;
          try {
            parsed = JSON.parse(event) as StreamDelta;
          } catch {
            continue;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { text: delta.content };
          }
          if (delta?.tool_calls) {
            toolCalls.push(delta.tool_calls);
          }
        }
      }
      // Las llamadas se entregan al final: sus argumentos llegan troceados y
      // hasta el último delta no se sabe si el JSON está completo.
      yield* toolCalls.drain();
    },
  };
}

/** Síntesis por HTTP (`/audio/speech`), en PCM listo para el reproductor. */
export function createOpenAiTts(): TtsStage {
  const model =
    env("START_TALK_PIPELINE_TTS_MODEL") ?? "gpt-4o-mini-tts";
  return {
    id: `openai:${model}`,
    async synthesize(text, { voice, signal }) {
      const response = await fetch(
        `${baseUrl("START_TALK_PIPELINE_TTS_BASE_URL")}/audio/speech`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requireKey("START_TALK_PIPELINE_TTS_KEY")}`,
          },
          body: JSON.stringify({
            model,
            voice,
            input: text,
            // PCM crudo: el reproductor de Start Talk ya toma s16le, así que
            // pedir mp3 obligaría a decodificar en el cliente.
            response_format: "pcm",
          }),
          signal,
        },
      );
      if (!response.ok) {
        await failFor("Text-to-speech", response);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      return { pcm: audio, sampleRate: TTS_SAMPLE_RATE };
    },
  };
}

/** Las tres etapas por defecto, cada una configurable por separado. */
export function createDefaultPipelineStages(
  llmModel?: string,
): VoicePipelineStages {
  return {
    stt: createOpenAiStt(),
    llm: createOpenAiLlm(llmModel),
    tts: createOpenAiTts(),
  };
}

/** True cuando hay credenciales suficientes para levantar la tubería. */
export function pipelineIsConfigured(): boolean {
  return Boolean(
    env("OPENAI_API_KEY") ??
      (env("START_TALK_PIPELINE_STT_KEY") &&
        env("START_TALK_PIPELINE_LLM_KEY") &&
        env("START_TALK_PIPELINE_TTS_KEY")),
  );
}
