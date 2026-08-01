import type { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import {
  buildChatResponseSpeechPrompt,
  getLatestAssistantResponse,
} from "./voiceDelegation";

function historyItem(role: "user" | "assistant", content: string) {
  return { message: { role, content } } as ChatHistoryItem;
}

describe("Start Talk chat response relay", () => {
  it("selects the latest assistant response with a session-scoped key", () => {
    const history = [
      historyItem("user", "First request"),
      historyItem("assistant", "First response"),
      historyItem("user", "Second request"),
      historyItem("assistant", "Second response"),
    ];

    expect(getLatestAssistantResponse(history, "session-7")).toEqual({
      key: "session-7:3:15",
      text: "Second response",
    });
  });

  it("returns no response when the chat has no assistant output", () => {
    expect(
      getLatestAssistantResponse(
        [historyItem("user", "Still waiting")],
        "session-8",
      ),
    ).toBeUndefined();
  });

  it("builds a speech-only prompt without truncating the chat response", () => {
    const response = "The implementation is complete. All tests passed.";
    const prompt = buildChatResponseSpeechPrompt(response);

    expect(prompt).toContain(response);
    expect(prompt).toContain("Read it aloud naturally and faithfully");
    expect(prompt).toContain("do not call tools");
  });
});
