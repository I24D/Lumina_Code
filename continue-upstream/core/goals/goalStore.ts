/**
 * goalStore.ts — Persistencia de las metas de sesión.
 *
 * Vive aparte de `sessionGoal.ts` a propósito, y no por gusto de ordenar: la
 * lógica de metas la usan LOS DOS LADOS — core, que corre en Node, y la GUI,
 * que corre dentro de un webview. Un solo `import fs` en el módulo de lógica
 * arrastra `core/util/paths.ts` al bundle del navegador, y ese módulo ejecuta
 * `dotenv.config()` y `os.homedir()` nada más cargarse. En el navegador esos
 * shims lanzan al tocarlos, así que el fallo no es un error suelto en consola:
 * revienta la evaluación del bundle entero, React no llega a montar y la
 * ventana se queda NEGRA.
 *
 * De ahí la frontera: `sessionGoal.ts` es puro y lo puede importar cualquiera;
 * el disco se toca solo aquí, y esto solo lo importa core.
 */
import fs from "node:fs";
import path from "node:path";

import { getContinueGlobalPath } from "../util/paths.js";

import { MAX_ALLOWED_TURNS, type SessionGoal } from "./sessionGoal.js";

type GoalStore = Record<string, SessionGoal>;

let cache: GoalStore | null = null;

function goalsFilePath(): string {
  return path.join(getContinueGlobalPath(), "lumina-session-goals.json");
}

function isGoal(value: unknown): value is SessionGoal {
  const goal = value as SessionGoal | undefined;
  return Boolean(
    goal &&
      typeof goal.sessionId === "string" &&
      typeof goal.text === "string" &&
      typeof goal.turnsUsed === "number" &&
      typeof goal.maxTurns === "number",
  );
}

function load(): GoalStore {
  if (cache) {
    return cache;
  }
  try {
    const file = goalsFilePath();
    if (!fs.existsSync(file)) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const store: GoalStore = {};
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (isGoal(value)) {
          // Se re-acota al leer: un archivo tocado a mano no puede saltarse el
          // tope de turnos.
          store[key] = {
            ...value,
            maxTurns: Math.max(1, Math.min(MAX_ALLOWED_TURNS, value.maxTurns)),
          };
        }
      }
    }
    cache = store;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(store: GoalStore): void {
  try {
    fs.writeFileSync(goalsFilePath(), JSON.stringify(store, null, 2), "utf8");
  } catch {
    // Disco no disponible: la meta sigue viva en memoria para esta sesión.
  }
}

export function getGoal(sessionId: string): SessionGoal | undefined {
  return load()[sessionId];
}

export function listGoals(): SessionGoal[] {
  return Object.values(load()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function setGoal(goal: SessionGoal): SessionGoal {
  const store = { ...load(), [goal.sessionId]: goal };
  cache = store;
  persist(store);
  return goal;
}

export function clearGoal(sessionId: string): void {
  const store = { ...load() };
  delete store[sessionId];
  cache = store;
  persist(store);
}

/** Limpia la caché (tests, o tras editar el archivo por fuera). */
export function resetGoalCache(): void {
  cache = null;
}
