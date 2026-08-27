import {
  readStartTalkVoiceEnvFile,
  type StartTalkVoiceConfigStore,
  type StartTalkVoiceEnv,
} from "core/startTalk/env";
import path from "node:path";
import * as vscode from "vscode";

const API_KEY_SECRET = "lumina.startTalk.geminiApiKey";
const OPENAI_API_KEY_SECRET = "lumina.startTalk.openAiApiKey";
const OPTIONS_KEY = "lumina.startTalk.geminiOptions";

type StoredStartTalkOptions = Omit<
  StartTalkVoiceEnv,
  "apiKey" | "openAiApiKey"
>;

function getConfiguredEnvFile(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("lumina.startTalk")
    .get<string>("envFile")
    ?.trim();

  if (!configured) {
    return undefined;
  }

  return path.resolve(configured);
}

export function createStartTalkConfigStore(
  context: vscode.ExtensionContext,
): StartTalkVoiceConfigStore {
  const save = async (config: StartTalkVoiceEnv): Promise<void> => {
    // Cada proveedor tiene su propio secreto: guardarlos juntos haría que
    // cambiar de proveedor pisara la clave del otro y hubiera que reintroducirla.
    if (config.apiKey) {
      await context.secrets.store(API_KEY_SECRET, config.apiKey);
    }
    if (config.openAiApiKey) {
      await context.secrets.store(OPENAI_API_KEY_SECRET, config.openAiApiKey);
    }

    const options: StoredStartTalkOptions = {
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      voiceName: config.voiceName,
      openAiVoiceName: config.openAiVoiceName,
    };
    await context.globalState.update(OPTIONS_KEY, options);
  };

  return {
    async load() {
      const [storedApiKey, storedOpenAiApiKey] = await Promise.all([
        context.secrets.get(API_KEY_SECRET),
        context.secrets.get(OPENAI_API_KEY_SECRET),
      ]);
      const storedOptions =
        context.globalState.get<StoredStartTalkOptions>(OPTIONS_KEY) ?? {};

      if (storedApiKey || storedOpenAiApiKey) {
        return {
          apiKey: storedApiKey,
          openAiApiKey: storedOpenAiApiKey,
          ...storedOptions,
        };
      }

      const envFile = getConfiguredEnvFile();
      if (!envFile) {
        return undefined;
      }

      const migrated = readStartTalkVoiceEnvFile(envFile);
      if (!migrated) {
        return undefined;
      }

      await save(migrated);
      return migrated;
    },
    save,
  };
}
