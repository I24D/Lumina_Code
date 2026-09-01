/**
 * Punto de entrada del proveedor de voz por tuberías.
 *
 * Presenta la misma forma que `ai.live.connect` y `connectOpenAIRealtime` —una
 * promesa que resuelve con la sesión ya lista— para que el manager abra los tres
 * proveedores por el mismo camino.
 */
import { createDefaultPipelineStages } from "./openAiStages.js";
import { SttLlmTtsSession, type VoicePipelineConfig } from "./SttLlmTtsSession.js";
import type { VoicePipelineStages } from "./types.js";
import type {
  LiveSessionCallbacks,
  LiveSessionHandle,
} from "../VoiceProvider.js";

export { SttLlmTtsSession, type VoicePipelineConfig } from "./SttLlmTtsSession.js";
export {
  createDefaultPipelineStages,
  pipelineIsConfigured,
} from "./openAiStages.js";
export * from "./types.js";

export function connectVoicePipeline({
  config,
  callbacks,
  stages = createDefaultPipelineStages(config.llmModel),
}: {
  config: VoicePipelineConfig;
  callbacks: LiveSessionCallbacks;
  /** Inyectable para pruebas; en producción salen del `.env`. */
  stages?: VoicePipelineStages;
}): Promise<LiveSessionHandle> {
  const session = new SttLlmTtsSession(stages, config, callbacks);
  // No hay socket que abrir: la tubería es HTTP por turno. Se anuncia lista en
  // el mismo orden que los otros proveedores (onopen y luego `setupComplete`)
  // para que el manager no necesite distinguirlos.
  callbacks.onopen();
  session.start();
  return Promise.resolve(session);
}
