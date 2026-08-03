/**
 * catalog.ts — The 12 named specialised agents the Director routes to.
 *
 * Each entry describes:
 *   - id          short slug
 *   - displayName user-facing name (used in voice/UI)
 *   - mission     one-line description
 *   - keywords    Spanish + English words that hint at this agent
 *   - tools       tool allowlist (the Director will hint the subagent
 *                 to prefer these — the runtime still enforces real ACL)
 *   - personality voice style snippet (added to the agent's prompt)
 *
 * The Director scores incoming intents against keywords and returns the
 * top match. When ambiguous, it returns the top-N for the agent to
 * confirm out loud with the user.
 */

export type SpecialisedAgentId =
  | "system-agent"
  | "desktop-agent"
  | "email-agent"
  | "calendar-agent"
  | "browser-agent"
  | "security-agent"
  | "research-agent"
  | "coding-agent"
  | "file-agent"
  | "vision-agent"
  | "voice-agent"
  | "automation-agent";

export type SpecialisedAgent = {
  readonly id: SpecialisedAgentId;
  readonly displayName: string;
  readonly mission: string;
  readonly keywords: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly personality: string;
};

export const SPECIALISED_AGENTS: ReadonlyArray<SpecialisedAgent> = [
  {
    id: "system-agent",
    displayName: "Atlas",
    mission: "Inspect and tune the local OS: processes, services, performance, drivers.",
    keywords: [
      "system", "sistema", "cpu", "ram", "memoria", "gpu", "bateria", "battery",
      "process", "proceso", "service", "servicio", "driver", "rendimiento",
      "performance", "disco", "disk",
    ],
    tools: [
      "lumina_system_metrics",
      "lumina_process_list",
      "lumina_awareness_snapshot",
      "lumina_awareness_subscribe",
      "lumina_shell_run",
    ],
    personality: "Habla como ingeniero de sistemas: cifras concretas, sin adjetivos vacíos.",
  },
  {
    id: "desktop-agent",
    displayName: "Mira",
    mission: "Control windows, focus, clipboard, keystrokes and the local UI tree.",
    keywords: [
      "window", "ventana", "focus", "foco", "click", "type", "teclado", "mouse",
      "clipboard", "portapapeles", "ui", "interfaz", "boton", "button",
    ],
    tools: [
      "lumina_window_control",
      "lumina_input_control",
      "lumina_input_focus_window",
      "lumina_input_type",
      "lumina_input_hotkey",
      "lumina_input_mouse_click",
      "lumina_vision_ui_tree",
      "lumina_clipboard",
    ],
    personality: "Voz tranquila y precisa. Confirma cada acción riesgosa.",
  },
  {
    id: "email-agent",
    displayName: "Postino",
    mission: "Read, search, summarise and send email via Gmail.",
    keywords: [
      "email", "correo", "gmail", "inbox", "bandeja", "mensaje", "send", "enviar",
      "responder", "reply", "draft", "borrador",
    ],
    tools: ["lumina_gmail", "lumina_episodic_remember"],
    personality: "Sintetiza correos en una frase. Pregunta antes de enviar.",
  },
  {
    id: "calendar-agent",
    displayName: "Horus",
    mission: "Read and schedule events on Google Calendar.",
    keywords: [
      "calendario", "calendar", "agenda", "reunion", "meeting", "event", "evento",
      "horario", "schedule", "cita",
    ],
    tools: ["lumina_calendar", "lumina_episodic_remember"],
    personality: "Resumen telegráfico: día, hora, asistentes. Sin floritura.",
  },
  {
    id: "browser-agent",
    displayName: "Nimbus",
    mission: "Drive Chromium for web research, form-filling and screenshots.",
    keywords: [
      "browser", "navegador", "chrome", "url", "web", "pagina", "page",
      "abrir", "open", "google", "buscar en internet", "search the web",
    ],
    tools: [
      "lumina_browser_drive",
      "lumina_vision_multimonitor",
      "lumina_episodic_remember",
    ],
    personality: "Describe la página por su estructura. Cuida los hashes de la URL.",
  },
  {
    id: "security-agent",
    displayName: "Vidrio",
    mission: "Risk evaluation, audit log review, secret hygiene.",
    keywords: [
      "security", "seguridad", "risk", "riesgo", "audit", "auditoria",
      "permiso", "permission", "secret", "secreto", "leak", "fuga",
    ],
    tools: ["lumina_risk_evaluate", "lumina_risk_recent", "lumina_awareness_snapshot"],
    personality: "Adversarial. Si algo huele a riesgo, lo dice antes de actuar.",
  },
  {
    id: "research-agent",
    displayName: "Soren",
    mission: "Multi-step research: search, fetch, deduplicate, summarise with citations.",
    keywords: [
      "research", "investiga", "investigar", "search", "buscar", "find", "compara",
      "compare", "what is", "que es", "definir", "explain",
    ],
    tools: ["lumina_browser_drive", "lumina_episodic_remember", "lumina_supabase_memory_remember"],
    personality: "Siempre cita la fuente. Marca explícitamente lo no verificado.",
  },
  {
    id: "coding-agent",
    displayName: "Bit",
    mission: "Write, refactor and review code; delegate to Lumina Code in VS Code.",
    keywords: [
      "code", "codigo", "programa", "program", "function", "funcion", "bug", "fix",
      "refactor", "test", "typescript", "python", "vscode",
    ],
    tools: ["lumina_code", "lumina_file_ops", "lumina_shell_run"],
    personality: "Pragmático. No agrega abstracciones que el repo no pide.",
  },
  {
    id: "file-agent",
    displayName: "Vault",
    mission: "Find, organise, move and rename files; clean disks.",
    keywords: [
      "file", "archivo", "carpeta", "folder", "rename", "renombrar", "move",
      "mover", "delete", "borrar", "find file", "buscar archivo", "downloads",
    ],
    tools: ["lumina_file_ops", "lumina_shell_run", "lumina_risk_evaluate"],
    personality: "Cauteloso con borrados. Siempre dry-run antes de aplicar.",
  },
  {
    id: "vision-agent",
    displayName: "Iris",
    mission: "See the screen: OCR, UI tree, multimonitor capture, element location.",
    keywords: [
      "vision", "ver", "see", "screen", "pantalla", "ocr", "screenshot",
      "captura", "describe", "describir", "que hay en la pantalla",
    ],
    tools: [
      "lumina_screen_capture",
      "lumina_vision_ui_tree",
      "lumina_vision_multimonitor",
    ],
    personality: "Describe lo visible. Distingue claramente OCR de inferencia.",
  },
  {
    id: "voice-agent",
    displayName: "Vox",
    mission: "Manage Start Talk session: TTS, transcript, voice settings.",
    keywords: [
      "voice", "voz", "talk", "hablar", "speak", "transcribe", "transcripcion",
      "tts", "stt", "microphone", "microfono",
    ],
    tools: ["lumina_notify_toast", "lumina_episodic_remember"],
    personality: "Conversacional, cálido. Lider de la interfaz por voz.",
  },
  {
    id: "automation-agent",
    displayName: "Forge",
    mission: "Compose plans, schedule cron jobs, execute multi-step routines.",
    keywords: [
      "automate", "automatiza", "automatizar", "schedule", "agenda", "cron",
      "every day", "cada dia", "routine", "rutina", "plan", "workflow",
    ],
    tools: [
      "lumina_action_plan",
      "lumina_intent_run",
      "lumina_episodic_remember",
      "lumina_working_memory_set",
    ],
    personality: "Optimiza por ejecución sin fricción. Reporta cada paso.",
  },
];

export function getAgent(id: SpecialisedAgentId): SpecialisedAgent {
  const a = SPECIALISED_AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent id: ${id}`);
  return a;
}
