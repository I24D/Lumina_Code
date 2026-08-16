import { afterEach, describe, expect, it } from "vitest";

import { resetLuminaEnvCache } from "../luminaBridge/luminaEnv.js";
import {
  clip,
  DEFAULT_VOICE_SEARCH_LIMITS,
  resolveProviderOrder,
  searchWebForVoice,
  shapeForVoice,
} from "./webSearch.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetLuminaEnvCache();
});

describe("clip", () => {
  it("deja intacto lo que ya cabe", () => {
    expect(clip("hola mundo", 50)).toBe("hola mundo");
  });

  it("colapsa espacios y saltos de línea", () => {
    expect(clip("  hola \n\n  mundo  ", 50)).toBe("hola mundo");
  });

  it("corta por palabra, no por la mitad de una", () => {
    const out = clip("necesito que esto se corte limpio en una frontera", 20);
    expect(out.endsWith("…")).toBe(true);
    // No debe quedar una palabra partida justo antes de los puntos suspensivos.
    expect(out.replace("…", "").trim()).not.toMatch(/\w-$/);
    expect(out.length).toBeLessThanOrEqual(22);
  });
});

describe("shapeForVoice", () => {
  it("respeta el tope de fuentes: nadie quiere oír cinco webs", () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      title: `Resultado ${i}`,
      url: `https://ejemplo.com/${i}`,
      snippet: "texto",
    }));
    const shaped = shapeForVoice("q", "tavily", { sources });
    expect(shaped.sources).toHaveLength(DEFAULT_VOICE_SEARCH_LIMITS.maxSources);
  });

  it("descarta URLs repetidas", () => {
    const shaped = shapeForVoice("q", "tavily", {
      sources: [
        { title: "A", url: "https://a.com", snippet: "uno" },
        { title: "A otra vez", url: "https://a.com", snippet: "dos" },
        { title: "B", url: "https://b.com", snippet: "tres" },
      ],
    });
    expect(shaped.sources.map((s) => s.url)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("ignora fuentes sin URL", () => {
    const shaped = shapeForVoice("q", "brave", {
      sources: [
        { title: "sin url", url: "", snippet: "x" },
        { title: "buena", url: "https://ok.com", snippet: "y" },
      ],
    });
    expect(shaped.sources).toHaveLength(1);
    expect(shaped.sources[0].url).toBe("https://ok.com");
  });

  it("recorta la respuesta sintetizada al límite de voz", () => {
    const answer = "palabra ".repeat(400);
    const shaped = shapeForVoice("q", "tavily", { answer, sources: [] });
    expect(shaped.answer!.length).toBeLessThanOrEqual(
      DEFAULT_VOICE_SEARCH_LIMITS.maxAnswerChars + 1,
    );
  });

  it("omite answer cuando el proveedor no la da", () => {
    const shaped = shapeForVoice("q", "brave", {
      sources: [{ title: "A", url: "https://a.com", snippet: "x" }],
    });
    expect(shaped.answer).toBeUndefined();
    expect(shaped.provider).toBe("brave");
  });
});

describe("resolveProviderOrder", () => {
  it("respeta el orden de SEARCH_PROVIDERS y filtra los no soportados", () => {
    process.env.SEARCH_PROVIDERS = "brave,duckduckgo,tavily";
    resetLuminaEnvCache();
    expect(resolveProviderOrder()).toEqual(["brave", "tavily"]);
  });

  it("deja los soportados como reserva aunque no estén configurados", () => {
    process.env.SEARCH_PROVIDERS = "brave";
    resetLuminaEnvCache();
    expect(resolveProviderOrder()).toEqual(["brave", "tavily"]);
  });
});

describe("searchWebForVoice", () => {
  it("rechaza una consulta vacía sin tocar la red", async () => {
    await expect(searchWebForVoice("   ")).resolves.toEqual({
      error: "empty_query",
    });
  });
});
