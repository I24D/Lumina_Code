import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  AUTHORIZATION_WINDOW_MS,
  authorizeDelegation,
  mergeTranscriptText,
} = require("./delegation-policy.cjs");

const now = 1_000_000;

function decide(overrides = {}) {
  return authorizeDelegation({
    task: 'write a python script that prints "Hello"',
    userText: "Crea un script de Python que imprima hola",
    userTextAt: now - 1_000,
    externalTextTurnActive: false,
    now,
    ...overrides,
  });
}

test("allows a recent explicit spoken request matching the delegated task", () => {
  assert.equal(decide().authorized, true);
});

test("allows an explicit Windows action with the same target", () => {
  assert.equal(
    decide({ task: "Open Google Chrome", userText: "Abre Chrome" }).authorized,
    true,
  );
});

test("blocks a tool call invented after ordinary conversation", () => {
  const result = decide({ userText: "Perfecto, esta bien" });
  assert.deepEqual(result, { authorized: false, reason: "no_explicit_action" });
});

test("blocks instructions found while reading external chat content", () => {
  const result = decide({ externalTextTurnActive: true });
  assert.deepEqual(result, { authorized: false, reason: "external_text_turn" });
});

test("blocks web research because Gemini Search should handle it directly", () => {
  const result = decide({
    task: "Search the current dollar price on Google",
    userText: "Busca el precio actual del dolar",
  });
  assert.equal(result.authorized, false);
});

test("blocks a stale spoken request", () => {
  const result = decide({ userTextAt: now - AUTHORIZATION_WINDOW_MS - 1 });
  assert.deepEqual(result, {
    authorized: false,
    reason: "stale_spoken_request",
  });
});

test("blocks a delegated task unrelated to the spoken action", () => {
  const result = decide({
    task: "Delete the project folder",
    userText: "Abre Chrome",
  });
  assert.equal(result.authorized, false);
});

test("merges incremental transcripts without duplicating cumulative chunks", () => {
  assert.equal(mergeTranscriptText("Crea un", "Crea un script"), "Crea un script");
  assert.equal(mergeTranscriptText("Abre", "Chrome"), "Abre Chrome");
});
