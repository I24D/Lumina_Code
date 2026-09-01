import { describe, expect, it, vi } from "vitest";

import {
  VoiceProviderRouter,
  type LiveSessionHandle,
  type VoiceProviderCapabilities,
} from "./VoiceProvider.js";

function session(): LiveSessionHandle {
  return {
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
}

/** Capacidades completas; cada prueba cambia solo lo que le importa. */
function caps(
  overrides: Partial<VoiceProviderCapabilities> = {},
): VoiceProviderCapabilities {
  return {
    architecture: "native-speech-to-speech",
    transport: "websocket",
    streamingInput: true,
    streamingOutput: true,
    tools: true,
    vision: true,
    sessionResumption: false,
    sessionRotation: false,
    ...overrides,
  };
}

describe("VoiceProviderRouter", () => {
  it("routes native and modular providers through the same contract", async () => {
    const router = new VoiceProviderRouter<{ token: string }>();
    const native = session();
    const pipeline = session();
    router.register({
      id: "native",
      capabilities: caps({ transport: "webrtc" }),
      connect: async () => native,
    });
    router.register({
      id: "pipeline",
      capabilities: caps({
        architecture: "stt-llm-tts",
        transport: "local",
        vision: false,
      }),
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
      capabilities: caps({ tools: false, vision: false }),
      connect: () => new Promise((done) => (resolve = done)),
    });

    await expect(router.connect("slow", undefined, 5)).rejects.toThrow(
      "did not connect",
    );
    resolve(late);
    await new Promise((done) => setTimeout(done, 0));
    expect(late.close).toHaveBeenCalledOnce();
  });

  it("dice quién sabe retomar la sesión y quién hay que rotar", () => {
    // El manager pregunta esto en vez de comparar el nombre del proveedor:
    // pedir un handle a quien no los entrega deja la reconexión esperando algo
    // que nunca llega, y rotar a quien no caduca tira la conversación entera.
    const router = new VoiceProviderRouter<void>();
    router.register({
      id: "live",
      capabilities: caps({ sessionResumption: true, sessionRotation: true }),
      connect: async () => session(),
    });
    router.register({
      id: "realtime",
      capabilities: caps(),
      connect: async () => session(),
    });

    expect(router.capabilities("live")?.sessionResumption).toBe(true);
    expect(router.capabilities("live")?.sessionRotation).toBe(true);
    expect(router.capabilities("realtime")?.sessionResumption).toBe(false);
    expect(router.capabilities("realtime")?.sessionRotation).toBe(false);
    // Un proveedor desconocido no puede hacer ninguna de las dos cosas.
    expect(router.capabilities("nope")).toBeUndefined();
  });
});
