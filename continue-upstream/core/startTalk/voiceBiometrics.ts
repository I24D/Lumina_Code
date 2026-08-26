/**
 * voiceBiometrics.ts — Client bridge to the I24D backend voice-biometrics API
 * (`/api/biometric/voice/*`, backed by the cerebro F3 feature).
 *
 * Start Talk buffers the raw microphone PCM of a user turn and, when the turn
 * ends, can send that clip here to identify WHO is speaking. The backend expects
 * base64 audio (WAV), so this module wraps the s16le PCM into a minimal WAV
 * container and POSTs it.
 *
 * Everything is best-effort: if the backend or its Python biometrics bridge is
 * unavailable, calls resolve to a non-match and never throw. Disabled by default
 * (needs the biometrics bridge); enable with START_TALK_BIOMETRICS=true.
 */
import { readLuminaEnv } from "../luminaBridge/luminaEnv.js";
import { resolveLuminaCoreUrl } from "../luminaBridge/runtimeClient.js";

const REQUEST_TIMEOUT_MS = 8000;

export interface SpeakerIdentification {
  matched: boolean;
  identityId?: string;
  name?: string;
  score?: number;
}

type SpeakerIdentificationPayload = {
  ok?: boolean;
  matched?: boolean;
  identityId?: unknown;
  name?: unknown;
  score?: unknown;
};

/** Validates the untrusted response returned by the optional biometrics API. */
export function normalizeSpeakerIdentification(
  data: SpeakerIdentificationPayload,
): SpeakerIdentification {
  if (!data?.ok || !data.matched) {
    return { matched: false };
  }
  const identityId =
    typeof data.identityId === "string"
      ? data.identityId.trim().slice(0, 160)
      : undefined;
  const name =
    typeof data.name === "string" ? data.name.trim().slice(0, 120) : undefined;
  const score =
    typeof data.score === "number" && Number.isFinite(data.score)
      ? Math.max(0, Math.min(1, data.score))
      : undefined;
  if (!identityId) {
    return { matched: false };
  }
  return { matched: true, identityId, name, score };
}

/** Voice biometrics is opt-in (requires the backend Python bridge). */
export function biometricsEnabled(): boolean {
  const flag = String(process.env.START_TALK_BIOMETRICS ?? "").toLowerCase();
  return flag === "true" || flag === "1" || flag === "on";
}

function authHeaders(): Record<string, string> {
  const token = readLuminaEnv("I24D_ADMIN_TOKEN");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Wraps mono s16le PCM into a 44-byte-header WAV container.
 * @param pcm   Raw little-endian signed 16-bit PCM samples.
 * @param sampleRate Sampling rate (Hz).
 */
export function encodeWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Identifies the speaker of a PCM clip against enrolled voiceprints.
 * Returns `{ matched: false }` on any failure (best-effort).
 */
export async function identifySpeaker(
  pcm: Buffer,
  sampleRate = 16000,
): Promise<SpeakerIdentification> {
  if (pcm.length === 0) {
    return { matched: false };
  }

  let baseUrl: string;
  try {
    baseUrl = resolveLuminaCoreUrl();
  } catch {
    return { matched: false };
  }

  const wavBase64 = encodeWav(pcm, sampleRate).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/biometric/voice/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ audio: wavBase64 }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { matched: false };
    }
    return normalizeSpeakerIdentification(
      (await response.json()) as SpeakerIdentificationPayload,
    );
  } catch {
    return { matched: false };
  } finally {
    clearTimeout(timer);
  }
}
