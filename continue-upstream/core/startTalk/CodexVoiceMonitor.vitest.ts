import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexVoiceMonitor,
  parseCodexFinalResponse,
} from "./CodexVoiceMonitor.js";

const temporaryDirectories: string[] = [];

function event(payload: Record<string, unknown>, type = "event_msg") {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for Codex voice response");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("CodexVoiceMonitor", () => {
  it("extracts only final assistant answers", () => {
    expect(
      parseCodexFinalResponse(
        event({
          type: "agent_message",
          phase: "final_answer",
          message: "  Finished answer  ",
        }),
      ),
    ).toBe("Finished answer");
    expect(
      parseCodexFinalResponse(
        event({ type: "agent_message", phase: "commentary", message: "Work" }),
      ),
    ).toBeUndefined();
    expect(
      parseCodexFinalResponse(
        event(
          { role: "assistant", phase: "final_answer", content: [] },
          "response_item",
        ),
      ),
    ).toBeUndefined();
  });

  it("tails VS Code sessions without replaying old answers or exec sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-"));
    temporaryDirectories.push(root);
    const day = path.join(root, "2026", "08", "15");
    fs.mkdirSync(day, { recursive: true });
    const visibleChat = path.join(day, "visible.jsonl");
    fs.writeFileSync(
      visibleChat,
      `${event({ type: "session_meta", source: "vscode" }, "session_meta")}\n${event({ type: "agent_message", phase: "final_answer", message: "Old" })}\n`,
    );

    const responses: string[] = [];
    const monitor = new CodexVoiceMonitor({
      sessionRoot: root,
      pollIntervalMs: 15,
      onResponse: ({ text }) => responses.push(text),
    });
    monitor.start();

    fs.appendFileSync(
      visibleChat,
      `${event({ type: "agent_message", phase: "commentary", message: "Draft" })}\n${event({ type: "agent_message", phase: "final_answer", message: "Read this" })}\n`,
    );
    const execChat = path.join(day, "exec.jsonl");
    fs.writeFileSync(
      execChat,
      `${event({ type: "session_meta", source: "exec" }, "session_meta")}\n${event({ type: "agent_message", phase: "final_answer", message: "Do not read" })}\n`,
    );

    await waitFor(() => responses.length === 1);
    monitor.stop();
    expect(responses).toEqual(["Read this"]);
  });
});
