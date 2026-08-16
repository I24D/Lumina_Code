import { describe, expect, it } from "vitest";

import { buildLiveTools } from "./StartTalkManager.js";

const GROUNDED = "gemini-2.5-flash-native-audio-latest";
const NOT_GROUNDED = "gemini-3.1-flash-live-preview";

/** Nombres de todas las funciones declaradas en el set de tools. */
function functionNames(tools: ReturnType<typeof buildLiveTools>): string[] {
  return tools.flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((fn) => fn.name ?? ""),
  );
}

function hasGoogleSearch(tools: ReturnType<typeof buildLiveTools>): boolean {
  return tools.some((tool) => Boolean(tool.googleSearch));
}

describe("buildLiveTools", () => {
  it("usa el grounding nativo cuando el modelo lo soporta, sin duplicar buscador", () => {
    const tools = buildLiveTools(true, true, GROUNDED);

    expect(hasGoogleSearch(tools)).toBe(true);
    // Mandar las dos formas de búsqueda a la vez seria pedirle al modelo que
    // elija entre herramientas redundantes.
    expect(functionNames(tools)).not.toContain("search_web");
  });

  it("da búsqueda propia al modelo SIN grounding nativo", () => {
    // Sin esto, 3.1 se queda mudo ante cualquier pregunta de actualidad y
    // responde que no puede acceder a internet.
    const tools = buildLiveTools(true, true, NOT_GROUNDED);

    expect(hasGoogleSearch(tools)).toBe(false);
    expect(functionNames(tools)).toContain("search_web");
  });

  it("NUNCA manda googleSearch al modelo incompatible", () => {
    // Mandarlo provoca un cierre 1011 garantizado y reconexion en bucle.
    for (const enableTools of [true, false]) {
      expect(hasGoogleSearch(buildLiveTools(enableTools, true, NOT_GROUNDED))).toBe(
        false,
      );
    }
  });

  it("sin búsqueda pedida no aparece ningún buscador", () => {
    const tools = buildLiveTools(true, false, NOT_GROUNDED);

    expect(hasGoogleSearch(tools)).toBe(false);
    expect(functionNames(tools)).not.toContain("search_web");
  });

  it("con tools desactivadas pero búsqueda pedida, manda solo el buscador", () => {
    const tools = buildLiveTools(false, true, NOT_GROUNDED);

    expect(functionNames(tools)).toEqual(["search_web"]);
    expect(functionNames(tools)).not.toContain("delegate_to_lumina_code");
  });

  it("mantiene las funciones de Lumina junto al buscador", () => {
    const names = functionNames(buildLiveTools(true, true, NOT_GROUNDED));

    expect(names).toContain("delegate_to_lumina_code");
    expect(names).toContain("stay_silent");
    expect(names).toContain("search_web");
  });
});
