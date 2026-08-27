import * as dotenv from "dotenv";
import fs from "fs";

import { getWorkspaceEnvFiles } from "../util/workspaceEnv.js";
import type { StartTalkProvider, StartTalkThinkingLevel } from "./types.js";
import {
  DEFAULT_VOICE_PROVIDER,
  isSupportedVoiceProvider,
} from "./VoiceProvider.js";
import { providerForModel } from "./voices.js";

/**
 * Configuración de la experiencia de voz. Cubre los dos proveedores a la vez
 * porque conviven: el usuario elige un modelo y de ahí sale el proveedor, así
 * que las claves y las voces de ambos tienen que estar disponibles al conectar.
 */
export type StartTalkVoiceEnv = {
  /** Proveedor preferido cuando no se ha fijado un modelo concreto. */
  provider?: StartTalkProvider;
  /** Clave de Google AI Studio, para `gemini-live`. */
  apiKey?: string;
  /** Clave de OpenAI, para `openai-realtime`. */
  openAiApiKey?: string;
  model?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  /** Voz preconstruida de Gemini Live (p. ej. `Leda`). */
  voiceName?: string;
  /** Voz de la Realtime API de OpenAI (p. ej. `marin`). */
  openAiVoiceName?: string;
};

/** Vista de la configuración para la UI. Nunca incluye secretos. */
export type StartTalkConfigStatus = {
  /** El proveedor activo tiene clave y se puede conversar. */
  configured: boolean;
  provider: StartTalkProvider;
  source: "workspace" | "secureStorage" | "missing";
  /** Qué proveedores tienen clave, para que la UI lo diga sin adivinar. */
  geminiConfigured: boolean;
  openAiConfigured: boolean;
  model?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  voiceName?: string;
  openAiVoiceName?: string;
};

export type StartTalkConfigUpdate = {
  provider?: StartTalkProvider;
  /** Se guardan en el almacén de secretos; nunca vuelven al webview. */
  apiKey?: string;
  openAiApiKey?: string;
  model?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  voiceName?: string;
  openAiVoiceName?: string;
};

export interface StartTalkVoiceConfigStore {
  load(): Promise<StartTalkVoiceEnv | undefined>;
  save(config: StartTalkVoiceEnv): Promise<void>;
}

function parseThinkingLevel(
  value: string | undefined,
): StartTalkThinkingLevel | undefined {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }

  return undefined;
}

function parseProvider(
  value: string | undefined,
): StartTalkProvider | undefined {
  const requested = value?.trim();
  return isSupportedVoiceProvider(requested) ? requested : undefined;
}

/** True si el objeto trae al menos una credencial utilizable. */
export function hasVoiceCredentials(env: StartTalkVoiceEnv): boolean {
  return Boolean(env.apiKey || env.openAiApiKey);
}

/**
 * Proveedor que se va a usar realmente, por orden de autoridad:
 *
 *  1. el modelo elegido en el orbe —su identificador ya dice de quién es—;
 *  2. la preferencia guardada o `START_TALK_PROVIDER`;
 *  3. la única clave que exista, para que configurar una sola ya baste;
 *  4. el proveedor por defecto.
 *
 * El paso 3 importa: sin él, tener solo la clave de Google y el proveedor por
 * defecto en OpenAI daría un "falta la API key" imposible de entender.
 */
export function resolveStartTalkProvider(
  config: StartTalkVoiceEnv,
  preferredModel?: string,
): StartTalkProvider {
  if (preferredModel?.trim()) {
    return providerForModel(preferredModel);
  }
  if (config.provider) {
    return config.provider;
  }
  if (config.openAiApiKey && !config.apiKey) {
    return "openai-realtime";
  }
  if (config.apiKey && !config.openAiApiKey) {
    return "gemini-live";
  }
  return DEFAULT_VOICE_PROVIDER;
}

function readVoiceEnv(
  read: (name: string) => string | undefined,
): StartTalkVoiceEnv {
  const apiKey = read("GEMINI_API_KEY") ?? read("GOOGLE_API_KEY");
  const openAiApiKey =
    read("START_TALK_OPENAI_API_KEY") ?? read("OPENAI_API_KEY");
  const geminiModel =
    read("START_TALK_GEMINI_MODEL") ??
    read("GEMINI_LIVE_MODEL") ??
    (read("GEMINI_MODEL")?.includes("live") ? read("GEMINI_MODEL") : undefined);
  const openAiModel = read("START_TALK_OPENAI_MODEL");
  const provider = parseProvider(read("START_TALK_PROVIDER"));

  // El modelo por defecto es uno solo, así que se elige el del proveedor que
  // se vaya a usar: el pedido explícitamente o, en su defecto, aquel del que
  // haya clave.
  const prefersOpenAi = provider
    ? provider === "openai-realtime"
    : Boolean(openAiApiKey);
  const model = prefersOpenAi
    ? (openAiModel ?? geminiModel)
    : (geminiModel ?? openAiModel);

  return {
    provider,
    apiKey,
    openAiApiKey,
    model,
    thinkingLevel: parseThinkingLevel(read("START_TALK_GEMINI_THINKING_LEVEL")),
    voiceName: read("START_TALK_GEMINI_VOICE"),
    openAiVoiceName: read("START_TALK_OPENAI_VOICE"),
  };
}

export function readStartTalkVoiceEnvFile(
  filepath: string,
): StartTalkVoiceEnv | undefined {
  if (!fs.existsSync(filepath)) {
    return undefined;
  }

  const parsed = dotenv.parse(fs.readFileSync(filepath));
  const env = readVoiceEnv((name) => parsed[name] || undefined);

  return hasVoiceCredentials(env) ? env : undefined;
}

export function resolveStartTalkVoiceEnv(
  workspaceDirs: string[],
): StartTalkVoiceEnv {
  const processEnv = readVoiceEnv((name) => process.env[name] || undefined);
  if (hasVoiceCredentials(processEnv)) {
    return processEnv;
  }

  for (const envFile of getWorkspaceEnvFiles(workspaceDirs)) {
    const env = readStartTalkVoiceEnvFile(envFile);
    if (env) {
      return env;
    }
  }

  return {};
}

/**
 * Combina la configuración del workspace con la global campo a campo.
 *
 * No es un "gana uno entero" a propósito: con dos proveedores es normal tener
 * la clave de OpenAI en el `.env` del proyecto y la de Google en el almacén
 * seguro (o al revés), y quedarse con un solo objeto dejaría fuera al otro
 * proveedor aunque estuviera configurado.
 */
export function selectStartTalkVoiceEnv(
  workspaceConfig: StartTalkVoiceEnv,
  globalConfig: StartTalkVoiceEnv | undefined,
): StartTalkVoiceEnv {
  if (!globalConfig) {
    return workspaceConfig;
  }

  return {
    provider: workspaceConfig.provider ?? globalConfig.provider,
    apiKey: workspaceConfig.apiKey ?? globalConfig.apiKey,
    openAiApiKey: workspaceConfig.openAiApiKey ?? globalConfig.openAiApiKey,
    model: workspaceConfig.model ?? globalConfig.model,
    thinkingLevel: workspaceConfig.thinkingLevel ?? globalConfig.thinkingLevel,
    voiceName: workspaceConfig.voiceName ?? globalConfig.voiceName,
    openAiVoiceName:
      workspaceConfig.openAiVoiceName ?? globalConfig.openAiVoiceName,
  };
}
