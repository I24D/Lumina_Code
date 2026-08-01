/**
 * VoiceProvider — extension seam for Start Talk real-time voice backends.
 *
 * Start Talk currently ships a single provider, "gemini-live" (implemented by
 * StartTalkManager), which gives native duplex audio, input/output
 * transcription, function calling and Google Search grounding in one bidi
 * stream.
 *
 * This module defines the abstraction so a fallback provider can be added
 * without touching the manager's call sites. A second provider (e.g. a
 * pipeline of streaming STT → LLM → streaming TTS) must satisfy the same
 * lifecycle contract:
 *
 *   connect → startCapture → (audio/transcript/toolCall events) → stop
 *
 * A hollow provider is intentionally NOT shipped: a real second backend
 * requires streaming speech-to-text, an LLM turn loop and streaming
 * text-to-speech wired to the same event surface. This file documents that
 * contract and resolves the active provider id.
 */
import type { StartTalkProvider } from "./types.js";

export const DEFAULT_VOICE_PROVIDER: StartTalkProvider = "gemini-live";

/** Provider ids that have a working implementation today. */
export const SUPPORTED_VOICE_PROVIDERS: readonly StartTalkProvider[] = [
  "gemini-live",
];

/**
 * Resolves the active provider from `START_TALK_PROVIDER`, falling back to the
 * default when unset or unsupported. Kept centralised so a future fallback can
 * be selected in one place.
 */
export function resolveVoiceProvider(): StartTalkProvider {
  const requested = String(
    process.env.START_TALK_PROVIDER ?? "",
  ).trim() as StartTalkProvider;
  if (requested && SUPPORTED_VOICE_PROVIDERS.includes(requested)) {
    return requested;
  }
  return DEFAULT_VOICE_PROVIDER;
}
