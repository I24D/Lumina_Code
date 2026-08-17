/**
 * sessionGoal.ts — Metas de sesión.
 *
 * Idea tomada de OpenChamber: en vez de pedir una cosa y revisar, le pones a la
 * sesión una LÍNEA DE META. Tras cada turno se comprueba el resultado y el
 * agente sigue trabajando hasta cumplirla, quedar bloqueado, o agotar el límite
 * que tú fijaste.
 *
 * Lo delicado aquí no es la idea sino los frenos. Un agente que se relanza solo
 * puede quemar la cuota entera o entrar en bucle, así que:
 *
 *   - Hay un techo de turnos SIEMPRE (`maxTurns`), sin excepción.
 *   - El veredicto se parsea de forma defensiva: si el juez no responde algo
 *     inequívoco, se asume `incomplete` y se consume turno igual. Nunca se
 *     interpreta una respuesta ambigua como "sigue trabajando indefinidamente".
 *   - `blocked` detiene el bucle en el acto: si el agente dice que no puede
 *     avanzar, insistir solo gasta dinero.
 *
 * El módulo es puro salvo la persistencia: el juicio se hace fuera y aquí solo
 * se decide qué hacer con él, para que se pueda testear sin modelo.
 */
import fs from "node:fs";
import path from "node:path";

import { getContinueGlobalPath } from "../util/paths.js";

export type SessionGoalStatus =
  | "active"
  | "completed"
  | "blocked"
  | "limitReached"
  | "cancelled";

export interface SessionGoal {
  sessionId: string;
  /** Lo que el usuario pidió conseguir, en sus palabras. */
  text: string;
  status: SessionGoalStatus;
  /** Turnos que el agente ya ha gastado persiguiendo la meta. */
  turnsUsed: number;
  /** Techo duro. Al alcanzarlo la meta pasa a `limitReached`. */
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
  /** Última explicación del juez, para que el usuario vea por qué va así. */
  lastReason?: string;
}

/** Veredicto del juez sobre si la meta está cumplida. */
export type GoalVerdict = "complete" | "incomplete" | "blocked";

export interface GoalEvaluation {
  verdict: GoalVerdict;
  reason: string;
}

/**
 * Turnos por defecto. Suficiente para una tarea real de varios pasos y lo
 * bastante bajo para que un bucle degenerado se note antes de doler.
 */
export const DEFAULT_MAX_TURNS = 12;
/** Tope absoluto: ni el usuario puede pedir más, por seguridad de cuota. */
export const MAX_ALLOWED_TURNS = 50;

function goalsFilePath(): string {
  return path.join(getContinueGlobalPath(), "lumina-session-goals.json");
}

/** Meta terminada: ni sigue trabajando ni admite más turnos. */
export function isGoalFinished(goal: SessionGoal): boolean {
  return goal.status !== "active";
}

/**
 * Prompt del juez. Se le pide un JSON estricto y CORTO a propósito: cuanto
 * menos margen de redacción, menos formas de que el parseo falle.
 *
 * El juez ve la meta y el último tramo de conversación, no el proyecto entero:
 * juzgar si algo se cumplió no requiere releer todo el historial, y mandarlo
 * dispararía el coste de cada turno.
 */
export function buildGoalEvaluationPrompt(
  goalText: string,
  recentConversation: string,
): string {
  return [
    "Eres un verificador. NO escribas código ni continúes la tarea.",
    "Tu único trabajo es decidir si la meta del usuario ya está cumplida.",
    "",
    `META: ${goalText}`,
    "",
    "ÚLTIMO TRAMO DE LA CONVERSACIÓN:",
    recentConversation,
    "",
    "Responde SOLO con un objeto JSON, sin texto alrededor ni bloque de código:",
    '{"verdict":"complete"|"incomplete"|"blocked","reason":"<una frase>"}',
    "",
    "Usa 'complete' solo si la meta está conseguida de verdad y verificada.",
    "Usa 'blocked' si hace falta algo que el agente no puede obtener solo:",
    "una credencial, una decisión del usuario, o un permiso denegado.",
    "En cualquier otro caso usa 'incomplete'.",
  ].join("\n");
}

/**
 * Parsea el veredicto de forma defensiva.
 *
 * Un juez puede envolver el JSON en un bloque de código, añadir texto antes, o
 * directamente divagar. Ante la duda se devuelve `incomplete`: es el único
 * valor seguro — no da por buena una meta sin cumplir ni corta el trabajo por
 * un fallo de formato, y como consume turno el bucle termina igualmente.
 */
export function parseGoalVerdict(raw: string): GoalEvaluation {
  const text = String(raw ?? "");

  // Primer objeto JSON que aparezca, venga suelto o dentro de ```json.
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        verdict?: unknown;
        reason?: unknown;
      };
      const verdict =
        parsed.verdict === "complete" ||
        parsed.verdict === "blocked" ||
        parsed.verdict === "incomplete"
          ? parsed.verdict
          : "incomplete";
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 300)
          : "Sin explicación del verificador.";
      return { verdict, reason };
    } catch {
      // JSON malformado: se cae al análisis por palabras de abajo.
    }
  }

  // Sin JSON utilizable. Solo se acepta una señal INEQUÍVOCA de fin; cualquier
  // otra cosa se trata como "sigue".
  const lowered = text.toLowerCase();
  if (/"?verdict"?\s*[:=]\s*"?complete/.test(lowered)) {
    return { verdict: "complete", reason: "El verificador la dio por cumplida." };
  }
  if (/"?verdict"?\s*[:=]\s*"?blocked/.test(lowered)) {
    return { verdict: "blocked", reason: "El verificador la dio por bloqueada." };
  }
  return {
    verdict: "incomplete",
    reason: "No se pudo leer el veredicto; se asume que falta trabajo.",
  };
}

/**
 * Aplica un veredicto a la meta y devuelve su nuevo estado.
 *
 * Aquí vive la regla del techo: el turno se cuenta SIEMPRE, incluso cuando el
 * veredicto es ilegible, para que ningún camino pueda dejar el bucle corriendo
 * sin consumir presupuesto.
 */
export function applyVerdict(
  goal: SessionGoal,
  evaluation: GoalEvaluation,
  now: number = Date.now(),
): SessionGoal {
  if (isGoalFinished(goal)) {
    return goal;
  }

  const turnsUsed = goal.turnsUsed + 1;
  const base = { ...goal, turnsUsed, updatedAt: now, lastReason: evaluation.reason };

  if (evaluation.verdict === "complete") {
    return { ...base, status: "completed" };
  }
  if (evaluation.verdict === "blocked") {
    return { ...base, status: "blocked" };
  }
  if (turnsUsed >= goal.maxTurns) {
    return { ...base, status: "limitReached" };
  }
  return { ...base, status: "active" };
}

/** True cuando el agente debe lanzar otro turno por su cuenta. */
export function shouldContinue(goal: SessionGoal): boolean {
  return goal.status === "active" && goal.turnsUsed < goal.maxTurns;
}

/** Mensaje que se le manda al agente para el siguiente turno automático. */
export function buildContinuationPrompt(goal: SessionGoal): string {
  return [
    `Sigues trabajando hacia esta meta: ${goal.text}`,
    goal.lastReason ? `Verificación del último turno: ${goal.lastReason}` : "",
    `Turno ${goal.turnsUsed + 1} de ${goal.maxTurns} como máximo.`,
    "Continúa desde donde lo dejaste. Si necesitas algo que no puedes obtener",
    "por ti misma, dilo claramente en vez de dar vueltas.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Crea una meta nueva, con el techo acotado al rango permitido. */
export function createGoal(
  sessionId: string,
  text: string,
  maxTurns: number = DEFAULT_MAX_TURNS,
  now: number = Date.now(),
): SessionGoal {
  const safeTurns = Math.max(
    1,
    Math.min(MAX_ALLOWED_TURNS, Math.floor(maxTurns) || DEFAULT_MAX_TURNS),
  );
  return {
    sessionId,
    text: String(text ?? "").trim().slice(0, 2000),
    status: "active",
    turnsUsed: 0,
    maxTurns: safeTurns,
    createdAt: now,
    updatedAt: now,
  };
}

// ---- Persistencia ----------------------------------------------------------

type GoalStore = Record<string, SessionGoal>;

let cache: GoalStore | null = null;

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
