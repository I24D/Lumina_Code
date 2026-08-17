import { describe, expect, it } from "vitest";

import {
  applyVerdict,
  buildContinuationPrompt,
  buildGoalEvaluationPrompt,
  createGoal,
  DEFAULT_MAX_TURNS,
  MAX_ALLOWED_TURNS,
  parseGoalVerdict,
  shouldContinue,
} from "./sessionGoal.js";

const goal = () => createGoal("s1", "Hacer pasar los tests", 3, 1000);

describe("createGoal", () => {
  it("acota el techo de turnos al máximo permitido", () => {
    // Un agente que se relanza solo puede quemar la cuota entera: el tope no
    // puede saltárselo nadie, ni el propio usuario.
    expect(createGoal("s", "x", 9999).maxTurns).toBe(MAX_ALLOWED_TURNS);
  });

  it("nunca deja un techo de cero o negativo", () => {
    expect(createGoal("s", "x", 0).maxTurns).toBeGreaterThanOrEqual(1);
    expect(createGoal("s", "x", -5).maxTurns).toBeGreaterThanOrEqual(1);
  });

  it("cae al valor por defecto si el número no es válido", () => {
    expect(createGoal("s", "x", NaN).maxTurns).toBe(DEFAULT_MAX_TURNS);
  });

  it("empieza activa y sin turnos gastados", () => {
    const created = goal();
    expect(created.status).toBe("active");
    expect(created.turnsUsed).toBe(0);
  });
});

describe("parseGoalVerdict", () => {
  it("lee un JSON limpio", () => {
    const result = parseGoalVerdict('{"verdict":"complete","reason":"listo"}');
    expect(result.verdict).toBe("complete");
    expect(result.reason).toBe("listo");
  });

  it("lee un JSON envuelto en un bloque de código", () => {
    const result = parseGoalVerdict(
      'Claro:\n```json\n{"verdict":"blocked","reason":"falta la clave"}\n```',
    );
    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("falta la clave");
  });

  it("ante una respuesta ilegible asume que falta trabajo", () => {
    // Es el único valor seguro: no da por buena una meta sin cumplir, y como
    // consume turno el bucle termina igualmente.
    expect(parseGoalVerdict("pues no sé qué decirte").verdict).toBe("incomplete");
    expect(parseGoalVerdict("").verdict).toBe("incomplete");
  });

  it("un JSON con veredicto inventado cuenta como incompleto", () => {
    expect(
      parseGoalVerdict('{"verdict":"casi","reason":"a medias"}').verdict,
    ).toBe("incomplete");
  });

  it("no confunde la palabra 'complete' suelta en prosa", () => {
    // Sin la forma `verdict: complete` no hay señal inequívoca de fin.
    expect(
      parseGoalVerdict("The task is not complete yet, keep going").verdict,
    ).toBe("incomplete");
  });

  it("recorta razones desmesuradas", () => {
    const long = "x".repeat(5000);
    const result = parseGoalVerdict(
      JSON.stringify({ verdict: "incomplete", reason: long }),
    );
    expect(result.reason.length).toBeLessThanOrEqual(300);
  });
});

describe("applyVerdict", () => {
  it("completa la meta", () => {
    const after = applyVerdict(goal(), { verdict: "complete", reason: "ok" });
    expect(after.status).toBe("completed");
    expect(after.turnsUsed).toBe(1);
  });

  it("bloquea sin agotar turnos: insistir solo gasta dinero", () => {
    const after = applyVerdict(goal(), {
      verdict: "blocked",
      reason: "falta credencial",
    });
    expect(after.status).toBe("blocked");
    expect(shouldContinue(after)).toBe(false);
  });

  it("sigue activa mientras queden turnos", () => {
    const after = applyVerdict(goal(), { verdict: "incomplete", reason: "a medias" });
    expect(after.status).toBe("active");
    expect(shouldContinue(after)).toBe(true);
  });

  it("pasa a limitReached justo al alcanzar el techo", () => {
    let current = goal(); // maxTurns 3
    for (let i = 0; i < 3; i++) {
      current = applyVerdict(current, { verdict: "incomplete", reason: "sigo" });
    }
    expect(current.turnsUsed).toBe(3);
    expect(current.status).toBe("limitReached");
    expect(shouldContinue(current)).toBe(false);
  });

  it("cuenta el turno incluso con un veredicto ilegible", () => {
    // Si un camino no consumiera turno, el bucle podría no terminar nunca.
    const after = applyVerdict(goal(), parseGoalVerdict("¯\\_(ツ)_/¯"));
    expect(after.turnsUsed).toBe(1);
  });

  it("una meta terminada ya no cambia", () => {
    const done = applyVerdict(goal(), { verdict: "complete", reason: "ok" });
    const again = applyVerdict(done, { verdict: "incomplete", reason: "no" });
    expect(again).toEqual(done);
  });

  it("guarda la explicación para que el usuario vea por qué va así", () => {
    const after = applyVerdict(goal(), {
      verdict: "incomplete",
      reason: "faltan dos tests",
    });
    expect(after.lastReason).toBe("faltan dos tests");
  });
});

describe("prompts", () => {
  it("el juez recibe la meta y tiene prohibido seguir la tarea", () => {
    const prompt = buildGoalEvaluationPrompt("Arreglar el login", "...");
    expect(prompt).toContain("Arreglar el login");
    expect(prompt).toMatch(/NO escribas código/i);
    expect(prompt).toContain("complete");
    expect(prompt).toContain("blocked");
  });

  it("la continuación indica en qué turno va y su techo", () => {
    const current = applyVerdict(goal(), {
      verdict: "incomplete",
      reason: "faltan dos tests",
    });
    const prompt = buildContinuationPrompt(current);

    expect(prompt).toContain("Hacer pasar los tests");
    expect(prompt).toContain("faltan dos tests");
    expect(prompt).toContain("Turno 2 de 3");
  });
});
