/**
 * transparency-panel.ts — Nivel 8 dashboard panel.
 *
 * Lit-html template that renders the most recent ActivityEntry items
 * grouped by category. The panel polls `/api/lumina/transparency` on
 * a 2 s interval through the existing GatewayBrowserClient — same
 * pattern as `heartbeat-display.ts`.
 *
 * Why not a websocket: the gateway already streams events for the chat
 * turn; the transparency panel is read-mostly and the diff is small.
 * Polling at 2s is cheap and keeps the surface aligned with the docs.
 */
import { html, nothing } from "lit";

export type TransparencyEntry = {
  readonly id: string;
  readonly atISO: string;
  readonly category:
    | "intent"
    | "tool"
    | "app"
    | "agent"
    | "file"
    | "email"
    | "page"
    | "command"
    | "risk"
    | "memory";
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: "SAFE" | "WARNING" | "HIGH_RISK" | "CRITICAL";
};

const CATEGORY_ICON: Readonly<Record<TransparencyEntry["category"], string>> = {
  intent: "◆",
  tool: "⚙",
  app: "▢",
  agent: "✦",
  file: "📄",
  email: "✉",
  page: "🌐",
  command: ">_",
  risk: "⚠",
  memory: "★",
};

const CATEGORY_LABEL: Readonly<Record<TransparencyEntry["category"], string>> = {
  intent: "Intención",
  tool: "Herramienta",
  app: "Aplicación",
  agent: "Agente",
  file: "Archivo",
  email: "Correo",
  page: "Página",
  command: "Comando",
  risk: "Riesgo",
  memory: "Memoria",
};

const RISK_CLASS: Readonly<Record<NonNullable<TransparencyEntry["risk"]>, string>> = {
  SAFE: "lumina-transparency__risk--safe",
  WARNING: "lumina-transparency__risk--warning",
  HIGH_RISK: "lumina-transparency__risk--high",
  CRITICAL: "lumina-transparency__risk--critical",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export type TransparencyPanelProps = {
  entries: ReadonlyArray<TransparencyEntry>;
  visible: boolean;
  onClose?: () => void;
};

export function renderTransparencyPanel(props: TransparencyPanelProps) {
  if (!props.visible) return nothing;
  if (props.entries.length === 0) {
    return html`
      <aside class="lumina-transparency lumina-transparency--empty" aria-live="polite">
        <header class="lumina-transparency__header">
          <span class="lumina-transparency__title">Transparencia</span>
          ${props.onClose
            ? html`<button class="lumina-transparency__close" @click=${props.onClose} aria-label="Cerrar">×</button>`
            : nothing}
        </header>
        <p class="lumina-transparency__placeholder">Lumina está en reposo. No hay actividad reciente.</p>
      </aside>
    `;
  }
  return html`
    <aside class="lumina-transparency" aria-live="polite">
      <header class="lumina-transparency__header">
        <span class="lumina-transparency__title">Transparencia</span>
        <span class="lumina-transparency__count">${props.entries.length}</span>
        ${props.onClose
          ? html`<button class="lumina-transparency__close" @click=${props.onClose} aria-label="Cerrar">×</button>`
          : nothing}
      </header>
      <ul class="lumina-transparency__list" role="log">
        ${props.entries.map(
          (e) => html`
            <li
              class="lumina-transparency__item${e.risk
                ? " " + (RISK_CLASS[e.risk] ?? "")
                : ""}"
            >
              <span class="lumina-transparency__icon" aria-hidden="true">${CATEGORY_ICON[e.category]}</span>
              <div class="lumina-transparency__body">
                <div class="lumina-transparency__top">
                  <span class="lumina-transparency__category">${CATEGORY_LABEL[e.category]}</span>
                  <time class="lumina-transparency__time" datetime=${e.atISO}>${formatTime(e.atISO)}</time>
                </div>
                <div class="lumina-transparency__summary">${e.summary}</div>
                ${e.detail
                  ? html`<div class="lumina-transparency__detail">${e.detail}</div>`
                  : nothing}
              </div>
            </li>
          `,
        )}
      </ul>
    </aside>
  `;
}
