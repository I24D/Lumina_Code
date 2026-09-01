import { describe, expect, it } from "vitest";

import {
  describePlanForAgent,
  planSpokenTask,
  startsWithAction,
} from "./TaskPlanner.js";

const steps = (goal: string): string[] =>
  planSpokenTask(goal)?.steps.map((step) => step.text) ?? [];

describe("startsWithAction", () => {
  it("reconoce la orden con el pronombre pegado", () => {
    expect(startsWithAction("corrígelo")).toBe(true);
    expect(startsWithAction("ejecútalas otra vez")).toBe(true);
    expect(startsWithAction("revisa el repositorio")).toBe(true);
    expect(startsWithAction("run the tests")).toBe(true);
  });

  it("no toma por orden lo que no lo es", () => {
    expect(startsWithAction("el corrector automático")).toBe(false);
    expect(startsWithAction("gastos")).toBe(false);
  });
});

describe("planSpokenTask", () => {
  it("descompone la orden de varias partes", () => {
    expect(
      steps(
        "revisa mi repositorio, encuentra por qué falla Start Talk, corrígelo y ejecuta las pruebas",
      ),
    ).toEqual([
      "revisa mi repositorio",
      "encuentra por qué falla Start Talk",
      "corrígelo",
      "ejecuta las pruebas",
    ]);
  });

  it("respeta los conectores de secuencia dictados", () => {
    expect(
      steps("compila la extensión y luego instala el VSIX. Después abre el orbe"),
    ).toEqual(["compila la extensión", "instala el VSIX", "abre el orbe"]);
  });

  it("no parte por el punto de un número de versión", () => {
    // "1.3.48" no lleva espacio tras el punto; una frase sí.
    expect(steps("instala la versión 1.3.48 y prueba el orbe")).toEqual([
      "instala la versión 1.3.48",
      "prueba el orbe",
    ]);
  });

  it("una sola orden no es un plan", () => {
    // Devolver un plan de un paso solo añadiría ruido a la tarea delegada.
    expect(planSpokenTask("busca el precio del oro")).toBeUndefined();
    expect(planSpokenTask("")).toBeUndefined();
  });

  it("no parte una enumeración que no son tareas", () => {
    // "ingresos" y "gastos" no son órdenes: son lo que hay que buscar.
    expect(
      planSpokenTask("busca el informe de ventas, ingresos y gastos"),
    ).toBeUndefined();
  });

  it("no convierte una frase con comas en un plan", () => {
    expect(
      planSpokenTask(
        "el proyecto, que lleva meses creciendo, necesita más orden",
      ),
    ).toBeUndefined();
  });

  it("deja pasar entero un discurso demasiado largo", () => {
    // Más de ocho pasos ya no es una orden hablada; partirla sería inventar.
    const long = Array.from({ length: 10 }, (_, i) => `revisa el archivo ${i}`)
      .join(" y luego ");
    expect(planSpokenTask(long)).toBeUndefined();
  });

  it("entrega al agente la orden literal y debajo los pasos", () => {
    const plan = planSpokenTask("abre el proyecto y ejecuta las pruebas")!;
    const described = describePlanForAgent(plan);

    // La frase original va primero: es la única fuente fiel de lo que se pidió.
    expect(described.startsWith("abre el proyecto y ejecuta las pruebas")).toBe(
      true,
    );
    expect(described).toContain("1. abre el proyecto");
    expect(described).toContain("2. ejecuta las pruebas");
  });
});
