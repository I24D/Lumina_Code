import { describe, expect, it } from "vitest";

import {
  clearSessionHistory,
  newSession,
  sessionSlice,
} from "./sessionSlice";

function stateWithMessages() {
  const base = sessionSlice.getInitialState();
  return {
    ...base,
    id: "sesion-fija",
    title: "Conversación en curso",
    history: [
      { message: { role: "user", content: "hola" } },
      { message: { role: "assistant", content: "qué tal" } },
    ] as any,
  };
}

describe("clearSessionHistory", () => {
  it("vacía los mensajes SIN cambiar de conversación", () => {
    // Este es el fallo que arregla: /clear usaba newSession, que genera un id
    // nuevo, así que en vez de limpiar el chat te dejaba en otro distinto y el
    // anterior seguía existiendo lleno.
    const before = stateWithMessages();
    const after = sessionSlice.reducer(before, clearSessionHistory());

    expect(after.history).toHaveLength(0);
    expect(after.id).toBe("sesion-fija");
    expect(after.title).toBe("Conversación en curso");
  });

  it("newSession sí cambia de conversación, y por eso no sirve para limpiar", () => {
    const before = stateWithMessages();
    const after = sessionSlice.reducer(before, newSession(undefined));

    expect(after.history).toHaveLength(0);
    expect(after.id).not.toBe("sesion-fija");
  });

  it("detiene cualquier generación en curso al limpiar", () => {
    const before = { ...stateWithMessages(), isStreaming: true };
    const after = sessionSlice.reducer(before, clearSessionHistory());

    expect(after.isStreaming).toBe(false);
  });

  it("descarta el estado derivado del contexto anterior", () => {
    const before = {
      ...stateWithMessages(),
      isPruned: true,
      contextPercentage: 0.9,
      compactionLoading: { 1: true },
      inlineErrorMessage: "algo" as any,
    };
    const after = sessionSlice.reducer(before, clearSessionHistory());

    expect(after.isPruned).toBe(false);
    expect(after.contextPercentage).toBeUndefined();
    expect(after.compactionLoading).toEqual({});
    expect(after.inlineErrorMessage).toBeUndefined();
  });
});
