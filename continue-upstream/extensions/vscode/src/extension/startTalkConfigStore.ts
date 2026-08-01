import {
  readStartTalkGeminiEnvFile,
  type StartTalkGeminiConfigStore,
  type StartTalkGeminiEnv,
} from "core/startTalk/env";
import path from "node:path";
import * as vscode from "vscode";

const API_KEY_SECRET = "lumina.startTalk.geminiApiKey";
const OPTIONS_KEY = "lumina.startTalk.geminiOptions";

type StoredStartTalkOptions = Omit<StartTalkGeminiEnv, "apiKey">;

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
): StartTalkGeminiConfigStore {
  const save = async (config: StartTalkGeminiEnv): Promise<void> => {
    if (config.apiKey) {
      await context.secrets.store(API_KEY_SECRET, config.apiKey);
    }

    const options: StoredStartTalkOptions = {
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      voiceName: config.voiceName,
    };
    await context.globalState.update(OPTIONS_KEY, options);
  };

  return {
    async load() {
      const storedApiKey = await context.secrets.get(API_KEY_SECRET);
      const storedOptions =
        context.globalState.get<StoredStartTalkOptions>(OPTIONS_KEY) ?? {};

      if (storedApiKey) {
        return { apiKey: storedApiKey, ...storedOptions };
      }

      const envFile = getConfiguredEnvFile();
      if (!envFile) {
        return undefined;
      }

      const migrated = readStartTalkGeminiEnvFile(envFile);
      if (!migrated?.apiKey) {
        return undefined;
      }

      await save(migrated);
      return migrated;
    },
    save,
  };
}
