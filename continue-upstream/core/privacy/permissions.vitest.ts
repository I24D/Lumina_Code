import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  defaultPermissions,
  sanitizePermissions,
} from "./permissions.js";

describe("registro de capacidades", () => {
  it("no tiene identificadores repetidos", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ninguna capacidad askOnly viene concedida de fábrica", () => {
    // Enviar mensajes o controlar el equipo sin preguntar no puede ser el
    // comportamiento por defecto de nadie.
    for (const capability of CAPABILITIES.filter((c) => c.askOnly)) {
      expect(capability.defaultPolicy).not.toBe("allow");
    }
  });

  it("todas describen qué implica concederlas", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.label.length).toBeGreaterThan(0);
      expect(capability.description.length).toBeGreaterThan(20);
    }
  });
});

describe("sanitizePermissions", () => {
  it("parte de los valores de fábrica cuando no hay nada guardado", () => {
    expect(sanitizePermissions(undefined)).toEqual(defaultPermissions());
    expect(sanitizePermissions(null)).toEqual(defaultPermissions());
    expect(sanitizePermissions("basura")).toEqual(defaultPermissions());
  });

  it("conserva las políticas válidas", () => {
    const result = sanitizePermissions({ camera: "block", webSearch: "ask" });
    expect(result.camera).toBe("block");
    expect(result.webSearch).toBe("ask");
  });

  it("descarta capacidades desconocidas", () => {
    const result = sanitizePermissions({ midi: "allow", usb: "allow" });
    expect(result).not.toHaveProperty("midi");
    expect(result).not.toHaveProperty("usb");
  });

  it("descarta valores que no son una política", () => {
    const result = sanitizePermissions({ camera: "quizás", screen: 42 });
    expect(result.camera).toBe(
      CAPABILITIES.find((c) => c.id === "camera")!.defaultPolicy,
    );
    expect(result.screen).toBe(
      CAPABILITIES.find((c) => c.id === "screen")!.defaultPolicy,
    );
  });

  it("degrada a 'ask' un 'allow' en capacidades que no lo admiten", () => {
    // El archivo se puede editar a mano: no debe poder concederse algo que la
    // interfaz nunca ofrecería.
    const askOnly = CAPABILITIES.filter((c) => c.askOnly).map((c) => c.id);
    expect(askOnly.length).toBeGreaterThan(0);

    const tampered = Object.fromEntries(askOnly.map((id) => [id, "allow"]));
    const result = sanitizePermissions(tampered);

    for (const id of askOnly) {
      expect(result[id]).toBe("ask");
    }
  });

  it("sí permite bloquear una capacidad askOnly", () => {
    const result = sanitizePermissions({ computerControl: "block" });
    expect(result.computerControl).toBe("block");
  });
});
