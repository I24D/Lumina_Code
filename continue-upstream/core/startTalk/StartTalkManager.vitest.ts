import { describe, expect, it } from "vitest";

import {
  consumeReplyAuthorization,
  grantReplyAuthorization,
  isAssistantEcho,
  isBackchannelInterruption,
} from "./StartTalkManager.js";

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

describe("autorización de respuestas", () => {
  const NOW = 1_000_000;

  it("sin un sí del usuario no se puede responder", () => {
    const ledger = new Map<string, number>();

    expect(
      consumeReplyAuthorization(ledger, "phone_link", "notif-1", NOW),
    ).toBe(false);
    expect(consumeReplyAuthorization(ledger, "whatsapp", "Hugo", NOW)).toBe(
      false,
    );
  });

  it("un sí autoriza UN envío y se gasta", () => {
    const ledger = new Map<string, number>();
    grantReplyAuthorization(ledger, "phone_link", ["notif-1"], NOW);

    expect(
      consumeReplyAuthorization(ledger, "phone_link", "notif-1", NOW + 1_000),
    ).toBe(true);
    // El segundo intento ya no tiene permiso: autorizar una respuesta no deja
    // la puerta abierta para el siguiente mensaje que entre.
    expect(
      consumeReplyAuthorization(ledger, "phone_link", "notif-1", NOW + 2_000),
    ).toBe(false);
  });

  it("autoriza solo aquello que el usuario oyó", () => {
    const ledger = new Map<string, number>();
    grantReplyAuthorization(ledger, "phone_link", ["notif-1"], NOW);

    expect(
      consumeReplyAuthorization(ledger, "phone_link", "notif-2", NOW),
    ).toBe(false);
  });

  it("un sí viejo caduca", () => {
    const ledger = new Map<string, number>();
    grantReplyAuthorization(ledger, "whatsapp", ["Hugo Tennessee"], NOW);

    expect(
      consumeReplyAuthorization(
        ledger,
        "whatsapp",
        "Hugo Tennessee",
        NOW + 10 * 60_000,
      ),
    ).toBe(false);
  });

  it("el contacto no distingue mayúsculas ni espacios de sobra", () => {
    const ledger = new Map<string, number>();
    grantReplyAuthorization(ledger, "whatsapp", ["Hugo Tennessee"], NOW);

    expect(
      consumeReplyAuthorization(ledger, "whatsapp", "  hugo tennessee ", NOW),
    ).toBe(true);
  });
});

describe("isBackchannelInterruption", () => {
  it("un ajá que la corta no es una petición", () => {
    expect(isBackchannelInterruption(true, "Ajá")).toBe(true);
    expect(isBackchannelInterruption(true, "entiendo.")).toBe(true);
  });

  it("el mismo ajá dicho en silencio SÍ es un turno del usuario", () => {
    // No la estaba cortando: está contestando a algo, y merece respuesta.
    expect(isBackchannelInterruption(false, "Ajá")).toBe(false);
  });

  it("no confunde una orden que empieza igual", () => {
    expect(isBackchannelInterruption(true, "sí, busca eso")).toBe(false);
    expect(isBackchannelInterruption(true, "para, para, espera")).toBe(false);
  });

  it("sin transcripción no adivina", () => {
    // El endpoint local no espera al proveedor: a veces el turno se cierra
    // antes de que llegue el texto. Callarla ahí sería peor que responder.
    expect(isBackchannelInterruption(true, "")).toBe(false);
    expect(isBackchannelInterruption(true, "   ")).toBe(false);
  });
});
