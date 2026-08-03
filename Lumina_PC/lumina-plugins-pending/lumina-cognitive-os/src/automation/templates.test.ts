/**
 * Tests for the intent template matcher (Nivel 9).
 */
import { describe, expect, it } from "vitest";
import { matchTemplate } from "./templates.js";

describe("matchTemplate", () => {
  it("matches 'organiza mi dia'", () => {
    const t = matchTemplate("Lumina, organiza mi día por favor");
    expect(t?.id).toBe("organiza-mi-dia");
    expect(t?.recipe.length).toBeGreaterThan(0);
  });

  it("matches the English 'organize my day'", () => {
    const t = matchTemplate("organize my day");
    expect(t?.id).toBe("organiza-mi-dia");
  });

  it("matches 'revisa correos importantes'", () => {
    const t = matchTemplate("revisa correos importantes");
    expect(t?.id).toBe("revisa-correos");
  });

  it("matches 'reporte de ventas'", () => {
    const t = matchTemplate("hazme el reporte de ventas");
    expect(t?.id).toBe("reporte-de-ventas");
  });

  it("returns null when nothing matches", () => {
    expect(matchTemplate("xyz qwerty 12345")).toBeNull();
  });
});
