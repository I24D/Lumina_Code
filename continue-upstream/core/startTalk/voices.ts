/**
 * Catálogo de modelos y voces de Start Talk, compartido por core y la GUI.
 *
 * Este módulo no importa nada de Node a propósito: el webview del orbe importa
 * estos VALORES (no solo los tipos), y un import de valor que arrastre
 * `fs`/`os`/`dotenv` deja la ventana de Start Talk en negro.
 */
import type { StartTalkProvider } from "./types.js";

export interface StartTalkVoiceOption {
  /** Identificador que se envía al proveedor. */
  id: string;
  /** Nombre visible en la interfaz. */
  label: string;
  /** Cómo suena, para que se pueda elegir sin probarlas todas. */
  description: string;
  /**
   * Voces que suenan a mujer joven. Es la persona de Lumina (ver el
   * `systemInstruction` de StartTalkManager), así que la UI las ofrece primero
   * y los valores por defecto salen de aquí.
   */
  youngFemale: boolean;
}

export interface StartTalkModelInfo {
  /** Identificador exacto del modelo en la API del proveedor. */
  model: string;
  label: string;
  description: string;
  provider: StartTalkProvider;
}

/**
 * Voces preconstruidas de Gemini Live. `Leda` es la juvenil y es la que ha
 * sido siempre la voz de Lumina en este proveedor.
 */
export const GEMINI_VOICES: readonly StartTalkVoiceOption[] = [
  {
    id: "Leda",
    label: "Leda",
    description: "Femenina, juvenil y luminosa",
    youngFemale: true,
  },
  {
    id: "Aoede",
    label: "Aoede",
    description: "Femenina, ligera y natural",
    youngFemale: true,
  },
  {
    id: "Kore",
    label: "Kore",
    description: "Femenina, firme y clara",
    youngFemale: true,
  },
  {
    id: "Charon",
    label: "Charon",
    description: "Masculina, informativa",
    youngFemale: false,
  },
  {
    id: "Fenrir",
    label: "Fenrir",
    description: "Masculina, enérgica",
    youngFemale: false,
  },
  {
    id: "Puck",
    label: "Puck",
    description: "Masculina, animada",
    youngFemale: false,
  },
];

/**
 * Voces de la Realtime API de OpenAI. `marin` y `cedar` son exclusivas de
 * tiempo real; `marin` es la femenina brillante y es la voz por defecto de
 * Lumina en este proveedor.
 */
export const OPENAI_REALTIME_VOICES: readonly StartTalkVoiceOption[] = [
  {
    id: "marin",
    label: "Marin",
    description: "Femenina, joven y brillante (exclusiva de tiempo real)",
    youngFemale: true,
  },
  {
    id: "coral",
    label: "Coral",
    description: "Femenina, cálida y cercana",
    youngFemale: true,
  },
  {
    id: "shimmer",
    label: "Shimmer",
    description: "Femenina, suave y serena",
    youngFemale: true,
  },
  {
    id: "sage",
    label: "Sage",
    description: "Femenina, tranquila y nítida",
    youngFemale: true,
  },
  {
    id: "alloy",
    label: "Alloy",
    description: "Neutra y equilibrada",
    youngFemale: false,
  },
  {
    id: "ash",
    label: "Ash",
    description: "Masculina, grave",
    youngFemale: false,
  },
  {
    id: "ballad",
    label: "Ballad",
    description: "Masculina, expresiva",
    youngFemale: false,
  },
  {
    id: "echo",
    label: "Echo",
    description: "Masculina, nítida",
    youngFemale: false,
  },
  {
    id: "verse",
    label: "Verse",
    description: "Masculina, versátil",
    youngFemale: false,
  },
  {
    id: "cedar",
    label: "Cedar",
    description: "Masculina, cálida (exclusiva de tiempo real)",
    youngFemale: false,
  },
];

/**
 * Voces del TTS de OpenAI, que es el que habla en la tubería. No son las mismas
 * que las de la Realtime API: mandar una de aquellas a `/audio/speech` se
 * rechaza, así que el catálogo va separado.
 */
export const VOICE_PIPELINE_VOICES: readonly StartTalkVoiceOption[] = [
  {
    id: "nova",
    label: "Nova",
    description: "Femenina, juvenil y cercana",
    youngFemale: true,
  },
  {
    id: "shimmer",
    label: "Shimmer",
    description: "Femenina, suave y clara",
    youngFemale: true,
  },
  {
    id: "coral",
    label: "Coral",
    description: "Femenina, cálida y expresiva",
    youngFemale: true,
  },
  {
    id: "sage",
    label: "Sage",
    description: "Neutra y serena",
    youngFemale: false,
  },
  {
    id: "onyx",
    label: "Onyx",
    description: "Masculina, grave",
    youngFemale: false,
  },
];

export const DEFAULT_GEMINI_VOICE = "Leda";
export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";
export const DEFAULT_VOICE_PIPELINE_VOICE = "nova";

/**
 * Modelo de voz por defecto de cada proveedor.
 *
 * En OpenAI es `gpt-realtime-2.1`, el modelo de voz más reciente: razonamiento
 * de nivel GPT-5 en tiempo real, ventana de 128k, entrada de imagen (necesaria
 * para que Lumina vea la pantalla) y esfuerzo de razonamiento ajustable.
 */
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";

export const GEMINI_LIVE_MODELS: readonly StartTalkModelInfo[] = [
  {
    model: DEFAULT_GEMINI_LIVE_MODEL,
    label: "Flash Live (3.1)",
    description: "Lecturas largas completas + búsqueda web propia",
    provider: "gemini-live",
  },
  {
    // `-latest` auto-sigue la última release 2.5 native-audio. Es el único
    // nivel con grounding nativo de Google Search (ver modelSupportsSearch),
    // pero trunca lecturas largas.
    model: "gemini-2.5-flash-native-audio-latest",
    label: "Native Audio (2.5)",
    description: "Voz natural con grounding de Google (corta textos largos)",
    provider: "gemini-live",
  },
];

export const OPENAI_REALTIME_MODELS: readonly StartTalkModelInfo[] = [
  {
    model: DEFAULT_OPENAI_REALTIME_MODEL,
    label: "GPT Realtime 2.1",
    description: "El modelo de voz más reciente de OpenAI: razona y ve",
    provider: "openai-realtime",
  },
  {
    model: "gpt-realtime-2.1-mini",
    label: "GPT Realtime 2.1 mini",
    description: "La misma voz, más barata y con menos latencia",
    provider: "openai-realtime",
  },
];

/**
 * Modelos de la tubería. El identificador lleva delante `pipeline/` y detrás el
 * modelo que RAZONA: es lo que hace que elegir aquí signifique algo, porque ese
 * nombre viaja hasta la etapa del LLM. Quién oye y quién habla se configuran en
 * el `.env` (`START_TALK_PIPELINE_STT_MODEL`, `START_TALK_PIPELINE_TTS_MODEL`).
 */
export const VOICE_PIPELINE_PREFIX = "pipeline/";

export const VOICE_PIPELINE_MODELS: readonly StartTalkModelInfo[] = [
  {
    model: `${VOICE_PIPELINE_PREFIX}gpt-5-mini`,
    label: "Tubería · GPT-5 mini",
    description: "Oye, razona y habla con tres modelos distintos",
    provider: "voice-pipeline",
  },
  {
    model: `${VOICE_PIPELINE_PREFIX}gpt-5`,
    label: "Tubería · GPT-5",
    description: "La misma tubería razonando con el modelo grande",
    provider: "voice-pipeline",
  },
];

export const DEFAULT_VOICE_PIPELINE_MODEL = VOICE_PIPELINE_MODELS[0].model;

/** El modelo que razona, sin el prefijo del proveedor. */
export function pipelineLlmModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value?.startsWith(VOICE_PIPELINE_PREFIX)
    ? value.slice(VOICE_PIPELINE_PREFIX.length) || undefined
    : undefined;
}

export const START_TALK_MODELS: readonly StartTalkModelInfo[] = [
  ...OPENAI_REALTIME_MODELS,
  ...GEMINI_LIVE_MODELS,
  ...VOICE_PIPELINE_MODELS,
];

/**
 * Deduce el proveedor a partir del identificador del modelo.
 *
 * El usuario elige un MODELO (en el orbe y en los ajustes), no un proveedor:
 * derivarlo aquí es lo que evita que una combinación imposible —una clave de
 * Google con `gpt-realtime-2.1`, o la voz `Leda` con OpenAI— llegue a la API.
 */
export function providerForModel(model: string | undefined): StartTalkProvider {
  const value = model?.trim().toLowerCase() ?? "";
  if (value.startsWith(VOICE_PIPELINE_PREFIX)) {
    return "voice-pipeline";
  }
  return value.startsWith("gpt-") ? "openai-realtime" : "gemini-live";
}

/**
 * Nombre del proveedor tal y como se le enseña al usuario.
 *
 * Vive aquí, con el catálogo, porque lo pintan la interfaz y los mensajes de
 * estado de core. Estuvo escrito dos veces como un ternario, y con el tercer
 * proveedor las dos copias mentían llamándolo "Gemini Live".
 */
export function providerLabel(provider: StartTalkProvider): string {
  switch (provider) {
    case "openai-realtime":
      return "OpenAI Realtime";
    case "voice-pipeline":
      return "Voice pipeline";
    default:
      return "Gemini Live";
  }
}

/**
 * Qué voz guardada le corresponde a cada proveedor.
 *
 * La tubería comparte campo con la Realtime API a propósito: son catálogos
 * distintos, pero `resolveVoiceForProvider` sustituye una voz ajena por la del
 * proveedor, así que un `marin` guardado se convierte en `nova` sin necesidad de
 * un tercer campo en el almacén de configuración.
 */
export function voiceFieldFor(
  provider: StartTalkProvider,
): "voiceName" | "openAiVoiceName" {
  return provider === "gemini-live" ? "voiceName" : "openAiVoiceName";
}

/** Voces elegibles del proveedor, con las de mujer joven delante. */
export function voicesForProvider(
  provider: StartTalkProvider,
): readonly StartTalkVoiceOption[] {
  switch (provider) {
    case "openai-realtime":
      return OPENAI_REALTIME_VOICES;
    case "voice-pipeline":
      return VOICE_PIPELINE_VOICES;
    default:
      return GEMINI_VOICES;
  }
}

/** Modelos elegibles del proveedor, el más reciente primero. */
export function modelsForProvider(
  provider: StartTalkProvider,
): readonly StartTalkModelInfo[] {
  switch (provider) {
    case "openai-realtime":
      return OPENAI_REALTIME_MODELS;
    case "voice-pipeline":
      return VOICE_PIPELINE_MODELS;
    default:
      return GEMINI_LIVE_MODELS;
  }
}

/** Voz por defecto del proveedor: siempre una de mujer joven. */
export function defaultVoiceForProvider(provider: StartTalkProvider): string {
  switch (provider) {
    case "openai-realtime":
      return DEFAULT_OPENAI_REALTIME_VOICE;
    case "voice-pipeline":
      return DEFAULT_VOICE_PIPELINE_VOICE;
    default:
      return DEFAULT_GEMINI_VOICE;
  }
}

/** Modelo por defecto del proveedor. */
export function defaultModelForProvider(provider: StartTalkProvider): string {
  switch (provider) {
    case "openai-realtime":
      return DEFAULT_OPENAI_REALTIME_MODEL;
    case "voice-pipeline":
      return DEFAULT_VOICE_PIPELINE_MODEL;
    default:
      return DEFAULT_GEMINI_LIVE_MODEL;
  }
}

/**
 * Ajusta un modelo al proveedor que se va a usar.
 *
 * La configuración guarda UN modelo y un proveedor por separado, así que una
 * preferencia antigua puede emparejar `gpt-realtime-2.1` con Gemini (o al
 * revés). Mandar ese par a la API es un fallo mudo: la sesión no conecta y
 * reintenta en bucle. Ante el desajuste manda el proveedor.
 */
export function resolveModelForProvider(
  provider: StartTalkProvider,
  model: string | undefined,
): string {
  const requested = model?.trim();
  return requested && providerForModel(requested) === provider
    ? requested
    : defaultModelForProvider(provider);
}

/**
 * Ajusta una voz al proveedor que se va a usar.
 *
 * Enviar `Leda` a OpenAI (o `marin` a Gemini) es un error de configuración que
 * la API rechaza y que deja la sesión en un bucle de reconexión, así que una
 * voz que no pertenece al proveedor se sustituye por su voz por defecto.
 */
export function resolveVoiceForProvider(
  provider: StartTalkProvider,
  voiceName: string | undefined,
): string {
  const requested = voiceName?.trim();
  if (
    requested &&
    voicesForProvider(provider).some((voice) => voice.id === requested)
  ) {
    return requested;
  }
  return defaultVoiceForProvider(provider);
}
