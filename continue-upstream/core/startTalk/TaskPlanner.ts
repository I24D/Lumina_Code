/**
 * TaskPlanner — descomponer una orden hablada larga en los pasos que contiene.
 *
 * El problema es concreto y se ve al usarlo: "revisa el repositorio, encuentra
 * por qué falla Start Talk, corrígelo y ejecuta las pruebas" llega al agente
 * como una sola frase, y lo que vuelve es el primer paso hecho y los otros tres
 * olvidados. Enumerarlos antes de delegar es lo que hace que no se pierdan.
 *
 * No usa ningún modelo, a propósito. Una orden hablada de varias partes YA
 * contiene sus partes como oraciones: separarlas es trabajo de texto, y hacerlo
 * con una llamada a un LLM añadiría segundos y coste a un camino que se recorre
 * en mitad de una conversación hablada. El agente al que se delega replanifica
 * por su cuenta de todas formas; esto solo se asegura de que reciba entera la
 * lista de lo que se le pidió.
 *
 * Es deliberadamente conservador: ante la duda devuelve `undefined` y la tarea
 * viaja tal cual, que es exactamente lo que pasaba antes. Partir de más una
 * orden simple sería peor que no partirla.
 */

/** Un paso suelto del plan, en el orden en que se dijo. */
export interface TaskStep {
  index: number;
  text: string;
}

export interface TaskPlan {
  /** La orden completa, tal y como se dijo. */
  goal: string;
  steps: TaskStep[];
}

/** Más de esto ya no es una orden hablada, es un discurso: no se parte. */
const MAX_STEPS = 8;
/** Un paso más corto que esto casi siempre es un trozo mal cortado. */
const MIN_STEP_CHARS = 4;

/**
 * Conectores que separan pasos de forma inequívoca. Van antes que la coma y la
 * "y" porque no dependen de que lo siguiente parezca un verbo.
 */
const SEQUENCE_MARKERS =
  /\s*(?:;|\n|,?\s*(?:y\s+)?(?:luego|despu[eé]s|a\s+continuaci[oó]n|por\s+[uú]ltimo|finalmente|al\s+final)\b|,?\s*(?:and\s+)?then\b|,?\s*after\s+that\b|\.\s+)\s*/giu;

/** Marcadores de lista dictados: "primero...", "1)...", "2.". */
const ORDINAL_PREFIX =
  /^(?:\d+\s*[.)-]\s*|primero\b|segundo\b|tercero\b|cuarto\b|quinto\b|first\b|second\b|third\b)[,\s]*/iu;

/**
 * Verbos con los que la gente da órdenes de trabajo.
 *
 * La lista es explícita en vez de morfológica porque el español no permite
 * reconocer un imperativo por la terminación sin equivocarse: "corrige" es una
 * orden y "corrige" dentro de "el corrector corrige" no lo es. Con una lista
 * cerrada el falso positivo es imposible por construcción, y lo peor que pasa
 * con un verbo que falte es que no se parta ahí, que es el comportamiento de
 * siempre.
 */
const ACTION_VERBS = new Set([
  // español
  "abre",
  "actualiza",
  "agrega",
  "analiza",
  "anade",
  "arregla",
  "borra",
  "busca",
  "cambia",
  "cierra",
  "comprueba",
  "compila",
  "configura",
  "copia",
  "corrige",
  "crea",
  "despliega",
  "documenta",
  "ejecuta",
  "elimina",
  "empaqueta",
  "encuentra",
  "escribe",
  "gaurda",
  "guarda",
  "haz",
  "instala",
  "lee",
  "lanza",
  "mide",
  "mira",
  "mueve",
  "optimiza",
  "prueba",
  "publica",
  "quita",
  "refactoriza",
  "renombra",
  "repara",
  "resuelve",
  "revisa",
  "sube",
  "valida",
  "verifica",
  // inglés
  "add",
  "analyze",
  "build",
  "check",
  "close",
  "commit",
  "create",
  "delete",
  "deploy",
  "document",
  "find",
  "fix",
  "install",
  "move",
  "open",
  "optimize",
  "package",
  "publish",
  "push",
  "read",
  "refactor",
  "remove",
  "rename",
  "run",
  "save",
  "test",
  "update",
  "validate",
  "verify",
  "write",
]);

/** Pronombres pegados al verbo: "corrígelo", "ejecútalas", "arréglamelo". */
const ENCLITICS = [
  "melo",
  "mela",
  "selo",
  "sela",
  "noslo",
  "nosla",
  "los",
  "las",
  "les",
  "lo",
  "la",
  "le",
  "me",
  "se",
  "nos",
  "te",
];

function foldAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase();
}

/**
 * ¿El fragmento empieza dando una orden?
 *
 * Se prueba el primer verbo con y sin pronombre pegado: "corrígelo" es
 * "corrige" + "lo", y sin deshacer esa unión la mitad de las órdenes reales
 * quedarían fuera de la lista.
 */
export function startsWithAction(fragment: string): boolean {
  const first = foldAccents(fragment.trim()).split(/[\s,;.]+/u)[0] ?? "";
  if (!first) {
    return false;
  }
  if (ACTION_VERBS.has(first)) {
    return true;
  }
  return ENCLITICS.some(
    (enclitic) =>
      first.endsWith(enclitic) &&
      ACTION_VERBS.has(first.slice(0, -enclitic.length)),
  );
}

function cleanStep(fragment: string): string {
  return fragment
    .replace(ORDINAL_PREFIX, "")
    .replace(/^[\s,;.]+|[\s,;.]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Parte por coma y por "y", pero solo cuando lo que sigue es otra orden.
 *
 * Sin esa condición, "busca el informe de ventas, ingresos y gastos" se
 * convertiría en tres tareas y el agente iría a buscar tres cosas que nadie
 * pidió por separado.
 */
function splitOnActionBoundaries(fragment: string): string[] {
  const parts = fragment.split(
    /\s*,\s*(?:y\s+|e\s+|and\s+)?|\s+(?:y|e|and)\s+/giu,
  );
  if (parts.length <= 1) {
    return [fragment];
  }

  const steps: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) {
      continue;
    }
    if (steps.length === 0 || startsWithAction(piece)) {
      steps.push(piece);
      continue;
    }
    // No era un paso nuevo: era parte del anterior, y se devuelve entero para
    // no perder el separador que lo unía.
    steps[steps.length - 1] = `${steps[steps.length - 1]}, ${piece}`;
  }
  return steps;
}

/**
 * El plan que contiene una orden hablada, o `undefined` si es un solo paso.
 *
 * Devolver `undefined` no es un fallo: la inmensa mayoría de lo que se le pide
 * a Lumina en voz alta es una sola cosa, y esas tareas viajan igual que antes.
 */
export function planSpokenTask(goal: string): TaskPlan | undefined {
  const clean = String(goal ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return undefined;
  }

  const fragments = clean
    .split(SEQUENCE_MARKERS)
    .flatMap((fragment) => splitOnActionBoundaries(fragment ?? ""))
    .map(cleanStep)
    .filter((step) => step.length >= MIN_STEP_CHARS);

  // El primer fragmento marca el tono: si ni siquiera él es una orden, esto no
  // era una lista de tareas sino una frase con comas.
  if (fragments.length < 2 || !startsWithAction(fragments[0])) {
    return undefined;
  }
  const actionable = fragments.filter((step) => startsWithAction(step));
  if (actionable.length < 2 || fragments.length > MAX_STEPS) {
    return undefined;
  }

  return {
    goal: clean,
    steps: fragments.map((text, index) => ({ index: index + 1, text })),
  };
}

/**
 * La tarea que se le entrega al agente: la orden literal y debajo sus pasos.
 *
 * La frase original va primero porque es la única fuente fiel de lo que se
 * pidió; la lista está debajo para que ninguno de los pasos se pierda por el
 * camino, que es exactamente lo que pasaba con las órdenes de varias partes.
 */
export function describePlanForAgent(plan: TaskPlan): string {
  const steps = plan.steps
    .map((step) => `${step.index}. ${step.text}`)
    .join("\n");
  return `${plan.goal}\n\nPasos pedidos, en orden. Complétalos todos:\n${steps}`;
}
