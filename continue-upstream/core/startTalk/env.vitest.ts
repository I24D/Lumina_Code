import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  readStartTalkVoiceEnvFile,
  resolveStartTalkProvider,
  selectStartTalkVoiceEnv,
} from "./env.js";
import {
  defaultVoiceForProvider,
  resolveModelForProvider,
  resolveVoiceForProvider,
  voicesForProvider,
} from "./voices.js";

const tempRoots: string[] = [];

function writeEnvFile(lines: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-talk-env-"));
  tempRoots.push(root);
  const envFile = path.join(root, ".env");
  fs.writeFileSync(envFile, lines.join("\n"), "utf8");
  return envFile;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Start Talk voice environment", () => {
  test("reads the configured env file outside the active workspace", () => {
    const envFile = writeEnvFile([
      "GEMINI_API_KEY=global-test-key",
      "START_TALK_GEMINI_MODEL=gemini-live-test",
      "START_TALK_GEMINI_THINKING_LEVEL=medium",
      "START_TALK_GEMINI_VOICE=Aoede",
    ]);

    expect(readStartTalkVoiceEnvFile(envFile)).toEqual({
      provider: undefined,
      apiKey: "global-test-key",
      openAiApiKey: undefined,
      model: "gemini-live-test",
      thinkingLevel: "medium",
      voiceName: "Aoede",
      openAiVoiceName: undefined,
    });
  });

  test("reads the OpenAI credentials and voice", () => {
    const envFile = writeEnvFile([
      "OPENAI_API_KEY=openai-test-key",
      "START_TALK_OPENAI_MODEL=gpt-realtime-2.1",
      "START_TALK_OPENAI_VOICE=marin",
    ]);

    expect(readStartTalkVoiceEnvFile(envFile)).toMatchObject({
      openAiApiKey: "openai-test-key",
      model: "gpt-realtime-2.1",
      openAiVoiceName: "marin",
    });
  });

  test("prefers the model of the provider that is actually configured", () => {
    // Con las dos claves y las dos variables de modelo, quedarse con el modelo
    // del proveedor equivocado haría que la sesión se conectase al otro.
    const envFile = writeEnvFile([
      "OPENAI_API_KEY=openai-test-key",
      "START_TALK_OPENAI_MODEL=gpt-realtime-2.1",
      "START_TALK_GEMINI_MODEL=gemini-live-test",
    ]);

    expect(readStartTalkVoiceEnvFile(envFile)?.model).toBe("gpt-realtime-2.1");
  });

  test("ignores an env file with no voice credentials at all", () => {
    expect(
      readStartTalkVoiceEnvFile(
        writeEnvFile(["START_TALK_OPENAI_VOICE=marin"]),
      ),
    ).toBeUndefined();
  });

  test("merges both providers instead of discarding a whole source", () => {
    // La clave de OpenAI en el proyecto y la de Google en el almacén seguro es
    // una combinación normal: quedarse con un solo objeto apagaría un proveedor
    // que sí está configurado.
    expect(
      selectStartTalkVoiceEnv(
        { openAiApiKey: "workspace-openai-key" },
        { apiKey: "global-gemini-key", voiceName: "Leda" },
      ),
    ).toEqual({
      provider: undefined,
      apiKey: "global-gemini-key",
      openAiApiKey: "workspace-openai-key",
      model: undefined,
      thinkingLevel: undefined,
      voiceName: "Leda",
      openAiVoiceName: undefined,
    });
  });

  test("keeps workspace credentials when both sources have the same provider", () => {
    expect(
      selectStartTalkVoiceEnv(
        { apiKey: "workspace-test-key", model: "workspace-model" },
        { apiKey: "global-test-key", model: "global-model" },
      ),
    ).toMatchObject({ apiKey: "workspace-test-key", model: "workspace-model" });
  });
});

describe("resolveStartTalkProvider", () => {
  test("the chosen model decides, over any stored preference", () => {
    expect(
      resolveStartTalkProvider(
        { provider: "gemini-live", apiKey: "k", openAiApiKey: "k" },
        "gpt-realtime-2.1",
      ),
    ).toBe("openai-realtime");
  });

  test("falls back to the only provider that has a key", () => {
    expect(resolveStartTalkProvider({ apiKey: "gemini-only" })).toBe(
      "gemini-live",
    );
    expect(resolveStartTalkProvider({ openAiApiKey: "openai-only" })).toBe(
      "openai-realtime",
    );
  });

  test("honours the stored preference when both keys exist", () => {
    expect(
      resolveStartTalkProvider({
        provider: "gemini-live",
        apiKey: "k",
        openAiApiKey: "k",
      }),
    ).toBe("gemini-live");
  });
});

describe("provider/model/voice consistency", () => {
  test("a model or voice from the other provider never reaches the API", () => {
    // Ese par es un fallo mudo: la API lo rechaza y la sesión reintenta en
    // bucle sin decir por qué. Ante el desajuste manda el proveedor.
    expect(
      resolveModelForProvider(
        "openai-realtime",
        "gemini-3.1-flash-live-preview",
      ),
    ).toBe("gpt-realtime-2.1");
    expect(resolveModelForProvider("gemini-live", "gpt-realtime-2.1")).toBe(
      "gemini-3.1-flash-live-preview",
    );
    expect(resolveVoiceForProvider("openai-realtime", "Leda")).toBe("marin");
    expect(resolveVoiceForProvider("gemini-live", "marin")).toBe("Leda");
  });

  test("keeps a valid pairing untouched", () => {
    expect(
      resolveModelForProvider("openai-realtime", "gpt-realtime-2.1-mini"),
    ).toBe("gpt-realtime-2.1-mini");
    expect(resolveVoiceForProvider("openai-realtime", "coral")).toBe("coral");
  });

  test("every provider default is a young female voice", () => {
    // Es la persona de Lumina: un default masculino la contradiría en cuanto
    // alguien conectara sin haber elegido voz.
    for (const provider of ["openai-realtime", "gemini-live"] as const) {
      const voice = voicesForProvider(provider).find(
        (entry) => entry.id === defaultVoiceForProvider(provider),
      );
      expect(voice?.youngFemale).toBe(true);
    }
  });
});
