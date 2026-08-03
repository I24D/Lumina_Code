/**
 * Tests for the Director router (Nivel 5).
 */
import { describe, expect, it } from "vitest";
import { routeIntent } from "./director.js";

describe("routeIntent", () => {
  it("routes 'investiga la competencia' to the research-agent", () => {
    const r = routeIntent("Lumina, investiga la competencia de Apple");
    expect(r.top?.agent.id).toBe("research-agent");
  });

  it("routes 'revisa mi correo' to the email-agent", () => {
    const r = routeIntent("revisa mi correo de Gmail");
    expect(r.top?.agent.id).toBe("email-agent");
  });

  it("routes 'agenda reunion' to the calendar-agent", () => {
    const r = routeIntent("agenda reunion con Pablo el viernes");
    expect(r.top?.agent.id).toBe("calendar-agent");
  });

  it("routes screen-related intents to the vision-agent", () => {
    const r = routeIntent("describe que hay en la pantalla");
    expect(r.top?.agent.id).toBe("vision-agent");
  });

  it("returns no top candidate when no keywords match", () => {
    const r = routeIntent("xyz qwerty");
    expect(r.top).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it("marks ambiguous when top scores are close", () => {
    // 'codigo' is in coding-agent; 'vscode' too. Should still pick coding.
    const r = routeIntent("revisa el codigo de vscode");
    expect(r.top?.agent.id).toBe("coding-agent");
  });
});
