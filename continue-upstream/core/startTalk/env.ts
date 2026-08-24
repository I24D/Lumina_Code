import * as dotenv from "dotenv";
import fs from "fs";

import { getWorkspaceEnvFiles } from "../util/workspaceEnv.js";
import type { StartTalkThinkingLevel } from "./types.js";

export type StartTalkGeminiEnv = {
  apiKey?: string;
  model?: string;
  thinkingLevel?: StartTalkThinkingLevel;
  voiceName?: string;
};

export interface StartTalkGeminiConfigStore {
  load(): Promise<StartTalkGeminiEnv | undefined>;
  save(config: StartTalkGeminiEnv): Promise<void>;
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

export function readStartTalkGeminiEnvFile(
  filepath: string,
): StartTalkGeminiEnv | undefined {
  if (!fs.existsSync(filepath)) {
    return undefined;
  }

  const parsed = dotenv.parse(fs.readFileSync(filepath));
  const apiKey = parsed.GEMINI_API_KEY ?? parsed.GOOGLE_API_KEY;
  const configuredModel =
    parsed.START_TALK_GEMINI_MODEL ?? parsed.GEMINI_LIVE_MODEL;
  const fallbackModel = parsed.GEMINI_MODEL?.includes("live")
    ? parsed.GEMINI_MODEL
    : undefined;

  if (!apiKey) {
    return undefined;
  }

  return {
    apiKey,
    model: configuredModel ?? fallbackModel,
    thinkingLevel: parseThinkingLevel(parsed.START_TALK_GEMINI_THINKING_LEVEL),
    voiceName: parsed.START_TALK_GEMINI_VOICE,
  };
}

export function resolveStartTalkGeminiEnv(
  workspaceDirs: string[],
): StartTalkGeminiEnv {
  const processApiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (processApiKey) {
    return {
      apiKey: processApiKey,
      model:
        process.env.START_TALK_GEMINI_MODEL ??
        process.env.GEMINI_LIVE_MODEL ??
        (process.env.GEMINI_MODEL?.includes("live")
          ? process.env.GEMINI_MODEL
          : undefined),
      thinkingLevel: parseThinkingLevel(
        process.env.START_TALK_GEMINI_THINKING_LEVEL,
      ),
      voiceName: process.env.START_TALK_GEMINI_VOICE,
    };
  }

  for (const envFile of getWorkspaceEnvFiles(workspaceDirs)) {
    const env = readStartTalkGeminiEnvFile(envFile);
    if (env) {
      return env;
    }
  }

  return {};
}

export function selectStartTalkGeminiEnv(
  workspaceConfig: StartTalkGeminiEnv,
  globalConfig: StartTalkGeminiEnv | undefined,
): StartTalkGeminiEnv {
  return workspaceConfig.apiKey
    ? workspaceConfig
    : (globalConfig ?? workspaceConfig);
}
