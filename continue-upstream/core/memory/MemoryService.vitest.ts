import { describe, expect, it } from "vitest";

import { MemoryService } from "./MemoryService.js";
import type { ExperienceRecord } from "./types.js";

function logCount(service: MemoryService, count: number, prefix = "goal") {
  for (let index = 0; index < count; index += 1) {
    service.logExperience({
      goal: `${prefix} ${index}`,
      summary: `resumen ${index}`,
      outcome: "success",
      toolNames: ["run_terminal_command"],
      tags: ["tool-call"],
    });
  }
}

describe("MemoryService growth", () => {
  it("stops growing once the stored limit is reached", () => {
    // El tope vivía sólo en sanitizeMemorySnapshot, así que se aplicaba al
    // releer el fichero y nunca mientras el proceso corría: una ventana abierta
    // seguía acumulando, y como cada llamada a herramienta reescribe el
    // snapshot entero de forma síncrona, cada una salía más cara que la
    // anterior.
    const service = new MemoryService();
    logCount(service, 2_050);

    expect(service.snapshot().experiences).toHaveLength(2_000);
  });

  it("drops evicted experiences from the search index too", () => {
    // Si el índice no suelta lo mismo que el registro, sigue devolviendo
    // experiencias que ya no están en el snapshot.
    const service = new MemoryService();
    service.logExperience({
      goal: "arrancar el orbe con permisos",
      summary: "primera experiencia, la que debe caer",
      outcome: "success",
      toolNames: [],
      tags: ["tool-call"],
    });
    logCount(service, 2_000, "relleno");

    expect(service.searchExperiences("orbe permisos")).toHaveLength(0);
  });

  it("keeps the newest experiences, not the oldest", () => {
    const service = new MemoryService();
    logCount(service, 2_010);

    const goals = service.snapshot().experiences.map((r) => r.goal);
    expect(goals.at(-1)).toBe("goal 2009");
    expect(goals).not.toContain("goal 0");
  });
});

describe("MemoryService search", () => {
  it("recalls a Spanish phrase typed without its accents", () => {
    // "número" se troceaba en "num"/"ero", así que buscar "numero" —la misma
    // palabra sin tilde— no encontraba nada.
    const service = new MemoryService();
    service.logExperience({
      goal: "consultar el número de cuenta",
      summary: "la operación quedó registrada",
      outcome: "success",
      toolNames: [],
      tags: [],
    });

    const matches: ReturnType<MemoryService["searchExperiences"]> =
      service.searchExperiences("numero de cuenta");
    expect(matches).toHaveLength(1);
    expect((matches[0].item as ExperienceRecord).goal).toContain("número");
  });
});
