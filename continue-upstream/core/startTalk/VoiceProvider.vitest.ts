import { describe, expect, it, vi } from "vitest";

import {
  VoiceProviderRouter,
  type LiveSessionHandle,
} from "./VoiceProvider.js";

function session(): LiveSessionHandle {
  return {
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
}

describe("VoiceProviderRouter", () => {
  it("routes native and modular providers through the same contract", async () => {
    const router = new VoiceProviderRouter<{ token: string }>();
    const native = session();
    const pipeline = session();
    router.register({
      id: "native",
      capabilities: {
        architecture: "native-speech-to-speech",
        transport: "webrtc",
        streamingInput: true,
        streamingOutput: true,
        tools: true,
        vision: true,
      },
      connect: async () => native,
    });
    router.register({
      id: "pipeline",
      capabilities: {
        architecture: "stt-llm-tts",
        transport: "local",
        streamingInput: true,
        streamingOutput: true,
        tools: true,
        vision: false,
      },
      connect: async () => pipeline,
    });

    await expect(router.connect("native", { token: "a" })).resolves.toBe(native);
    await expect(router.connect("pipeline", { token: "b" })).resolves.toBe(
      pipeline,
    );
    expect(router.capabilities("pipeline")?.architecture).toBe("stt-llm-tts");
  });

  it("rejects a connection that hangs and closes it if it resolves late", async () => {
    const router = new VoiceProviderRouter<void>();
    const late = session();
    let resolve!: (value: LiveSessionHandle) => void;
    router.register({
      id: "slow",
      capabilities: {
        architecture: "native-speech-to-speech",
        transport: "websocket",
        streamingInput: true,
        streamingOutput: true,
        tools: false,
        vision: false,
      },
      connect: () => new Promise((done) => (resolve = done)),
    });

    await expect(router.connect("slow", undefined, 5)).rejects.toThrow(
      "did not connect",
    );
    resolve(late);
    await new Promise((done) => setTimeout(done, 0));
    expect(late.close).toHaveBeenCalledOnce();
  });
});
