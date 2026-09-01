import { describe, expect, it, vi } from "vitest";

import {
  ConversationTurnManager,
  isVoiceBackchannel,
  looksLikeIncompleteUtterance,
} from "./ConversationTurnManager.js";

describe("ConversationTurnManager", () => {
  it("publishes the real conversation lifecycle", () => {
    const clock = { value: 1_000 };
    const onChange = vi.fn();
    const manager = new ConversationTurnManager(onChange, () => clock.value);

    manager.onConnected(true);
    manager.onUserSpeechStart();
    clock.value += 1_200;
    manager.onTranscript("Busca el modelo de voz más reciente.");
    manager.onUserSpeechEnd();
    manager.onToolStart("search_web");
    manager.onAssistantAudio();
    manager.onTurnComplete(true);

    expect(onChange.mock.calls.map(([event]) => event.state)).toEqual([
      "LISTENING",
      "USER_SPEAKING",
      "THINKING",
      "TOOL_EXECUTION",
      "ASSISTANT_SPEAKING",
      "LISTENING",
    ]);
    expect(manager.snapshot().turnId).toBe(1);
    expect(manager.profile().speechRateWpm).toBe(350);
  });

  it("extends the endpoint for an unfinished partial sentence", () => {
    const manager = new ConversationTurnManager();
    manager.onUserSpeechStart();
    manager.onTranscript("Quiero que busques los modelos de voz y");

    expect(
      manager.endpointSilenceMs({
        baseSilenceMs: 520,
        crowded: false,
        turnMs: 1_500,
      }),
    ).toBe(940);
  });

  it("learns a slow speaker's pauses without allowing an endless turn", () => {
    const manager = new ConversationTurnManager();
    manager.observePause(900);
    manager.observePause(1_100);
    manager.observePause(1_000);

    expect(
      manager.endpointSilenceMs({
        baseSilenceMs: 520,
        crowded: false,
        turnMs: 2_000,
      }),
    ).toBe(1_350);
    expect(manager.profile()).toMatchObject({
      averagePauseMs: 1_000,
      observedPauses: 3,
    });

    manager.onTranscript("Necesito esto y");
    expect(
      manager.endpointSilenceMs({
        baseSilenceMs: 520,
        crowded: false,
        turnMs: 2_000,
      }),
    ).toBe(1_600);
  });
});

describe("turn semantics", () => {
  it("recognises incomplete pauses without treating complete questions as open", () => {
    expect(looksLikeIncompleteUtterance("Quiero buscar...")).toBe(true);
    expect(looksLikeIncompleteUtterance("Busca Gemini y")).toBe(true);
    expect(looksLikeIncompleteUtterance("¿Cuál es el modelo más reciente?")).toBe(
      false,
    );
  });

  it("distinguishes acknowledgement backchannels from new requests", () => {
    expect(isVoiceBackchannel("Ajá.")).toBe(true);
    expect(isVoiceBackchannel("Sí")).toBe(true);
    expect(isVoiceBackchannel("Sí, busca esa información")).toBe(false);
  });
});
