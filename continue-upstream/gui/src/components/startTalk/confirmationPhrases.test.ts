import { describe, expect, it } from "vitest";

import {
  isAffirmativeReply,
  isNegativeReply,
  normalizeSpokenReply,
} from "./confirmationPhrases";

describe("spoken confirmation detection", () => {
  it("normalizes accents, case and punctuation", () => {
    expect(normalizeSpokenReply("¡Sí, por favor!")).toBe("si por favor");
    expect(normalizeSpokenReply("  ÓRALE  ")).toBe("orale");
  });

  it("accepts short affirmations in Spanish and English", () => {
    for (const yes of [
      "sí",
      "si",
      "Sí, por favor",
      "ok",
      "okay",
      "dale",
      "vale",
      "claro",
      "perfecto",
      "me parece bien",
      "está bien",
      "hazlo por favor",
      "adelante",
      "yes",
      "go ahead",
      "sure",
    ]) {
      expect(isAffirmativeReply(yes), yes).toBe(true);
    }
  });

  it("accepts imperative reply verbs anywhere in a short utterance", () => {
    expect(isAffirmativeReply("respondele que ya voy")).toBe(true);
    expect(isAffirmativeReply("dile que sí")).toBe(true);
    expect(isAffirmativeReply("mándale un saludo")).toBe(true);
  });

  it("rejects declines even when they contain an affirmative token", () => {
    expect(isAffirmativeReply("no")).toBe(false);
    expect(isAffirmativeReply("ahora no")).toBe(false);
    expect(isAffirmativeReply("no, mejor no le respondas")).toBe(false);
    expect(isNegativeReply("no gracias")).toBe(true);
    expect(isNegativeReply("dejalo así")).toBe(true);
  });

  it("does not treat a long sentence as a confirmation", () => {
    expect(
      isAffirmativeReply(
        "sí bueno estaba pensando en muchas cosas y no sé qué decirte todavía",
      ),
    ).toBe(false);
  });

  it("treats empty or unrelated speech as neither yes nor no", () => {
    expect(isAffirmativeReply("")).toBe(false);
    expect(isAffirmativeReply("qué hora es")).toBe(false);
    expect(isNegativeReply("qué hora es")).toBe(false);
  });
});
