import { describe, expect, it } from "vitest";

import { isAssistantEcho } from "./StartTalkManager.js";

const SAID =
  "Te llego un mensaje de Cricket: tu cuenta ya no incluye el plan de HBO Max.";

describe("isAssistantEcho", () => {
  it("reconoce su propia frase devuelta por el micrófono", () => {
    expect(isAssistantEcho("tu cuenta ya no incluye el plan", SAID)).toBe(true);
  });

  it("la reconoce aunque el eco se transcriba con errores", () => {
    // "Max" oído como "más": ya no es la frase literal, pero casi todo lo
    // "oído" sigue saliendo de lo que ella acababa de decir.
    expect(
      isAssistantEcho("tú cuenta, ya no incluyé el plan de HBO más", SAID),
    ).toBe(true);
  });

  it("no toca lo que el usuario dice de verdad", () => {
    expect(
      isAssistantEcho("recuérdame pagar el recibo el viernes", SAID),
    ).toBe(false);
  });

  it("nunca descarta una interrupción corta", () => {
    // "para" y "espera" son suyas aunque ella acabe de decirlas: silenciarlas
    // sería quitarle al usuario la única forma de cortarla.
    expect(isAssistantEcho("para", SAID)).toBe(false);
    expect(isAssistantEcho("espera", "espera un momento por favor")).toBe(false);
  });

  it("no descarta nada si ella no había dicho nada", () => {
    expect(isAssistantEcho("cual es el numero de cuenta", "")).toBe(false);
  });
});
