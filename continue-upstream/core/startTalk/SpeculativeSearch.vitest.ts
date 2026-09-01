import { describe, expect, it, vi } from "vitest";

import {
  SpeculativeSearch,
  extractSpeculativeQuery,
  looksLikeSearchRequest,
  queryOverlap,
} from "./SpeculativeSearch.js";
import type { VoiceSearchOutcome } from "./webSearch.js";

const HIT: VoiceSearchOutcome = {
  query: "modelo de voz mas reciente de gemini",
  provider: "tavily",
  sources: [],
};

function tracker(result: VoiceSearchOutcome = HIT) {
  const calls: string[] = [];
  const run = vi.fn(async (query: string) => {
    calls.push(query);
    return result;
  });
  return { calls, run };
}

describe("looksLikeSearchRequest", () => {
  it("reconoce la petición explícita", () => {
    expect(looksLikeSearchRequest("busca en internet el precio del oro")).toBe(
      true,
    );
    expect(looksLikeSearchRequest("search the web for the latest model")).toBe(
      true,
    );
  });

  it("no adivina una búsqueda donde no la piden", () => {
    // Muchas de estas acaban en búsqueda, pero fallar cuesta una llamada de API
    // por cada vez, así que se exige que la pidan.
    expect(looksLikeSearchRequest("¿cuál es la última versión?")).toBe(false);
    expect(looksLikeSearchRequest("abre el archivo del proyecto")).toBe(false);
  });
});

describe("extractSpeculativeQuery", () => {
  it("quita el arranque y deja lo que hay que buscar", () => {
    expect(
      extractSpeculativeQuery(
        "a ver, busca en internet cuál es el modelo de voz más reciente de Gemini",
      ),
    ).toBe("cual es el modelo de voz mas reciente de gemini");
  });

  it("no arriesga nada con un 'busca' a secas", () => {
    expect(extractSpeculativeQuery("busca")).toBeUndefined();
    expect(extractSpeculativeQuery("búscame eso")).toBeUndefined();
  });
});

describe("queryOverlap", () => {
  it("da por buena la versión limpia de lo mismo", () => {
    expect(
      queryOverlap(
        "cual es el modelo de voz mas reciente de gemini",
        "modelo de voz mas reciente Gemini",
      ),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it("separa dos preguntas distintas", () => {
    expect(
      queryOverlap(
        "cual es el modelo de voz mas reciente de gemini",
        "precio del billete de tren a Sevilla",
      ),
    ).toBeLessThan(0.4);
  });

  it("con dos palabras no se pronuncia", () => {
    expect(queryOverlap("el oro", "el oro")).toBe(0);
  });
});

describe("SpeculativeSearch", () => {
  it("adelanta la búsqueda y la entrega cuando el modelo la pide", async () => {
    const { calls, run } = tracker();
    const speculation = new SpeculativeSearch({ run });

    speculation.observe(
      "busca en internet cuál es el modelo de voz más reciente de Gemini",
    );
    expect(calls).toHaveLength(1);

    const taken = speculation.take("modelo de voz más reciente Gemini");
    await expect(taken).resolves.toEqual(HIT);
    // El resultado ya estaba: la llamada del tool no vuelve a salir a la red.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("se arriesga una sola vez por turno", () => {
    const { run } = tracker();
    const speculation = new SpeculativeSearch({ run });

    speculation.observe("busca en internet el precio del oro hoy");
    speculation.observe("busca en internet el precio del oro hoy en euros");
    expect(run).toHaveBeenCalledTimes(1);

    speculation.beginTurn();
    speculation.observe("busca en internet la altura del Teide");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("espera a que la frase deje de estar cortada", () => {
    const { run } = tracker();
    const speculation = new SpeculativeSearch({ run });

    // Lo que sigue a "de" cambia la consulta entera; esperar sale gratis.
    speculation.observe("busca en internet el precio del billete de");
    expect(run).not.toHaveBeenCalled();

    speculation.observe("busca en internet el precio del billete de tren");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("no contesta la pregunta de al lado", async () => {
    const { run } = tracker();
    const speculation = new SpeculativeSearch({ run });
    speculation.observe("busca en internet el precio del oro hoy en euros");

    // El usuario cambió de idea a media frase: el adelanto no sirve y se tira.
    expect(speculation.take("altura del Teide en metros")).toBeUndefined();
  });

  it("tira un adelanto viejo", () => {
    let now = 0;
    const { run } = tracker();
    const speculation = new SpeculativeSearch({
      run,
      ttlMs: 1_000,
      now: () => now,
    });
    speculation.observe("busca en internet el precio del oro hoy en euros");

    now = 5_000;
    expect(speculation.take("precio del oro hoy en euros")).toBeUndefined();
  });

  it("un fallo del adelanto no se convierte en un rechazo sin dueño", async () => {
    const run = vi.fn(async () => {
      throw new Error("network down");
    });
    const speculation = new SpeculativeSearch({ run });
    speculation.observe("busca en internet el precio del oro hoy en euros");

    await expect(
      speculation.take("precio del oro hoy en euros"),
    ).resolves.toEqual({ error: "speculation_failed" });
  });

  it("aborta lo que quede en vuelo al cancelar", () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn(async (_query: string, incoming: AbortSignal) => {
      signal = incoming;
      return HIT;
    });
    const speculation = new SpeculativeSearch({ run });
    speculation.observe("busca en internet el precio del oro hoy en euros");

    speculation.cancel();
    expect(signal?.aborted).toBe(true);
    expect(speculation.take("precio del oro hoy en euros")).toBeUndefined();
  });
});
