/**
 * templates.ts — Pre-built voice intents that resolve to concrete plans.
 *
 * These are the 9 phrases the user asked about (and a few more) wired to
 * the right sequence of tool calls. The agent calls lumina_intent_run
 * with the matched template id; the runtime returns a recipe that the
 * agent then executes (each step is still an independent tool call so
 * existing approval semantics apply).
 *
 * NB: We don't hard-code any model output. The recipe is a list of
 * tool-call hints and prompt snippets; the LLM fills the gaps.
 */

export type IntentTemplate = {
  readonly id: string;
  readonly displayName: string;
  /** Voice phrases that trigger this template (Spanish + English). */
  readonly triggers: ReadonlyArray<string>;
  /** Human-readable description shown on the Transparency panel. */
  readonly description: string;
  /** Step recipe: ordered list of `{toolName, hint}`. The hint is a
   *  short sentence the agent reads to fill in tool params. */
  readonly recipe: ReadonlyArray<{
    readonly toolName: string;
    readonly hint: string;
  }>;
};

export const INTENT_TEMPLATES: ReadonlyArray<IntentTemplate> = [
  {
    id: "organiza-mi-dia",
    displayName: "Organiza mi día",
    triggers: ["organiza mi dia", "organize my day", "planea mi dia", "plan my day"],
    description:
      "Lee calendario y correos, identifica top 3 prioridades, propone bloques de tiempo y los confirma con el usuario.",
    recipe: [
      { toolName: "lumina_calendar", hint: "list today's events; condense to one line each." },
      { toolName: "lumina_gmail", hint: "list unread emails of the last 24h; flag high importance." },
      { toolName: "lumina_episodic_recall", hint: "recall yesterday's open loops (tags=['todo','open'])." },
      { toolName: "lumina_working_memory_set", hint: "set currentIntent='daily-planning' and pin top 3 tasks." },
    ],
  },
  {
    id: "revisa-correos",
    displayName: "Revisa correos importantes",
    triggers: ["revisa correos", "revisa mis correos", "check my email", "check important emails"],
    description: "Resume correos no leídos importantes, agrupados por remitente y tema.",
    recipe: [
      { toolName: "lumina_gmail", hint: "list unread of last 48h; rank by sender importance and length." },
      { toolName: "lumina_episodic_remember", hint: "log the review with tags=['email','review']." },
    ],
  },
  {
    id: "responde-pendientes",
    displayName: "Responde mensajes pendientes",
    triggers: ["responde pendientes", "responde mensajes", "reply pending", "answer pending messages"],
    description: "Para cada correo no respondido, propone borrador y pide confirmación verbal antes de enviar.",
    recipe: [
      { toolName: "lumina_gmail", hint: "find threads where last message is from a contact and >24h old." },
      { toolName: "lumina_risk_evaluate", hint: "category='communication' for each draft before sending." },
      { toolName: "lumina_gmail", hint: "send only after the user says 'sí, envía'." },
    ],
  },
  {
    id: "reporte-de-ventas",
    displayName: "Prepara reporte de ventas",
    triggers: ["reporte de ventas", "sales report", "informe ventas"],
    description:
      "Recolecta datos del proyecto activo y produce un resumen ejecutivo con cifras.",
    recipe: [
      { toolName: "lumina_working_memory_get", hint: "discover the current project." },
      { toolName: "lumina_file_ops", hint: "find files like sales*.csv, ventas*.xlsx in the project dir." },
      { toolName: "lumina_code", hint: "ask the coding agent to compute aggregates and produce a one-page summary." },
    ],
  },
  {
    id: "analiza-proyecto",
    displayName: "Analiza este proyecto",
    triggers: ["analiza este proyecto", "analyze this project", "audita el proyecto"],
    description: "Recorre estructura, deps, tests y comenta puntos fuertes/débiles.",
    recipe: [
      { toolName: "lumina_working_memory_get", hint: "infer the current project path." },
      { toolName: "lumina_file_ops", hint: "list top-level files and tree depth ≤2." },
      { toolName: "lumina_code", hint: "delegate the audit to the coding agent; expect a structured report." },
    ],
  },
  {
    id: "revisa-errores",
    displayName: "Revisa errores de código",
    triggers: ["revisa errores", "revisa errores de codigo", "review code errors", "find bugs"],
    description: "Lanza el code-review del cognitive agent y devuelve hallazgos con severidad.",
    recipe: [
      { toolName: "lumina_code", hint: "trigger /code-review on the current branch." },
      { toolName: "lumina_episodic_remember", hint: "log findings with tags=['code','bugs']." },
    ],
  },
  {
    id: "agenda-reunion",
    displayName: "Agenda reuniones",
    triggers: ["agenda reunion", "agenda reuniones", "schedule meeting", "schedule a meeting"],
    description: "Encuentra huecos comunes, propone título y bloque, crea el evento.",
    recipe: [
      { toolName: "lumina_calendar", hint: "list next 7 days busy slots." },
      { toolName: "lumina_risk_evaluate", hint: "category='communication' before sending the invite." },
      { toolName: "lumina_calendar", hint: "create event after explicit confirmation." },
    ],
  },
  {
    id: "investiga-competencia",
    displayName: "Investiga la competencia",
    triggers: ["investiga la competencia", "investiga competencia", "investigate competition", "competitor research"],
    description: "Multi-source web research con citas y resumen ejecutivo.",
    recipe: [
      { toolName: "lumina_browser_drive", hint: "open up to 5 sources; read innerText." },
      { toolName: "lumina_episodic_remember", hint: "log each source with tags=['research','competition']." },
    ],
  },
  {
    id: "prepara-presentacion",
    displayName: "Prepara una presentación",
    triggers: ["prepara presentacion", "prepara una presentacion", "prepare presentation", "make slides"],
    description:
      "Outline de slides a partir del proyecto activo; produce un .md que Lumina Code puede convertir.",
    recipe: [
      { toolName: "lumina_working_memory_get", hint: "find the project." },
      { toolName: "lumina_code", hint: "ask the coding agent to draft slides outline as markdown." },
      { toolName: "lumina_file_ops", hint: "save the outline next to the project root." },
    ],
  },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .trim();
}

export function matchTemplate(utterance: string): IntentTemplate | null {
  const u = normalize(utterance);
  if (u.length === 0) return null;
  let best: { tpl: IntentTemplate; score: number } | null = null;
  for (const tpl of INTENT_TEMPLATES) {
    for (const trig of tpl.triggers) {
      const tn = normalize(trig);
      if (u.includes(tn)) {
        const score = tn.length / Math.max(1, u.length);
        if (!best || score > best.score) {
          best = { tpl, score };
        }
      }
    }
  }
  return best ? best.tpl : null;
}
