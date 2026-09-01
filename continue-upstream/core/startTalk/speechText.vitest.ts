import { describe, expect, it } from "vitest";

import {
  composeVoiceResponse,
  StreamingSentenceSegmenter,
} from "./speechText.js";

describe("composeVoiceResponse", () => {
  it("keeps prose while leaving code and long URLs on screen", () => {
    const spoken = composeVoiceResponse(
      "Revisa [la guía](https://example.com/a/very/long/path). ```ts\nconst x = 1;\n```",
    );
    expect(spoken).toContain("Revisa la guía.");
    expect(spoken).toContain("Te dejé el código en pantalla.");
    expect(spoken).toContain("Te dejé los enlaces en pantalla.");
    expect(spoken).not.toContain("https://");
    expect(spoken).not.toContain("const x");
  });
});

describe("StreamingSentenceSegmenter", () => {
  it("releases the first sentence while the model is still generating", () => {
    const segmenter = new StreamingSentenceSegmenter();
    expect(segmenter.push("La primera parte ya está lista. La seg")).toEqual([
      "La primera parte ya está lista.",
    ]);
    expect(segmenter.push("unda continúa")).toEqual([]);
    expect(segmenter.flush()).toEqual(["La segunda continúa"]);
  });

  it("no espera un punto que no va a llegar", () => {
    // Hay modelos que escriben un párrafo entero sin puntuar. Sin el tope,
    // Lumina se quedaría muda hasta el final de la generación.
    const text =
      "esto es una enumeración larga sin ningún signo de puntuación que la corte";
    const segmenter = new StreamingSentenceSegmenter(40);
    const released = segmenter.push(text);

    expect(released).toHaveLength(1);
    expect(released[0].length).toBeLessThanOrEqual(40);
    // Corta por un hueco entre palabras: lo emitido es un prefijo literal.
    expect(text.startsWith(released[0])).toBe(true);
    expect(text[released[0].length]).toBe(" ");
    expect(segmenter.flush()[0]).toContain("puntuación");
  });

  it("no emite nada cuando solo llegó espacio en blanco", () => {
    const segmenter = new StreamingSentenceSegmenter();
    expect(segmenter.push("   ")).toEqual([]);
    expect(segmenter.flush()).toEqual([]);
  });
});
