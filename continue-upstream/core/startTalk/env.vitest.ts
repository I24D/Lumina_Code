import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readStartTalkGeminiEnvFile, selectStartTalkGeminiEnv } from "./env.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Start Talk Gemini environment", () => {
  test("reads the configured env file outside the active workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-talk-env-"));
    tempRoots.push(root);
    const envFile = path.join(root, ".env");
    fs.writeFileSync(
      envFile,
      [
        "GEMINI_API_KEY=global-test-key",
        "START_TALK_GEMINI_MODEL=gemini-live-test",
        "START_TALK_GEMINI_THINKING_LEVEL=medium",
        "START_TALK_GEMINI_VOICE=Aoede",
      ].join("\n"),
      "utf8",
    );

    expect(readStartTalkGeminiEnvFile(envFile)).toEqual({
      apiKey: "global-test-key",
      model: "gemini-live-test",
      thinkingLevel: "medium",
      voiceName: "Aoede",
    });
  });

  test("uses global credentials when the workspace has none", () => {
    const globalConfig = { apiKey: "global-test-key", model: "global-model" };

    expect(selectStartTalkGeminiEnv({}, globalConfig)).toBe(globalConfig);
  });

  test("keeps workspace credentials when both sources exist", () => {
    const workspaceConfig = {
      apiKey: "workspace-test-key",
      model: "workspace-model",
    };

    expect(
      selectStartTalkGeminiEnv(workspaceConfig, {
        apiKey: "global-test-key",
        model: "global-model",
      }),
    ).toBe(workspaceConfig);
  });
});
