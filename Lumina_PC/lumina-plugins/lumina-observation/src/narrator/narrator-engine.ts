/**
 * NarratorEngine — turns ObservationChanges into one-line Spanish narrations.
 *
 * Hard rules baked into the system prompt:
 *   - Reply in Spanish, ≤ 80 characters, one sentence, no lists.
 *   - Never read paths, hashes, process IDs.
 *   - Never narrate "nothing changed" — the change filter never calls us
 *     with an empty list.
 *   - If the only change is a window switch to the same app family
 *     (e.g. Chrome→Chrome), prefer a vague "seguiste navegando" over a
 *     literal title read (avoids leaking page titles).
 *
 * Two layers of anti-spam:
 *   1. Rate limit (per minute) — narrations exceeding the cap are dropped.
 *   2. Recent-narration dedupe — if a narration line would repeat one
 *      uttered in the last 90 s, we skip it.
 */
import { LlmClient } from "./llm-client.js";
import type { ObservationChange, Narration } from "../types.js";

const SYSTEM_PROMPT = [
  "Eres la voz interna de Lumina. Resume cambios técnicos en UNA sola oración en español, ≤ 80 caracteres.",
  "Reglas estrictas:",
  "- No leas rutas, hashes ni IDs.",
  "- No narres listas. Una sola idea por oración.",
  "- Si Dal sigue en la misma app (ej. Chrome → Chrome), describe la acción a alto nivel, no el título.",
  "- Si Dal vuelve después de ausentarse, salúdalo brevemente.",
  "- Sé directa. Sin saludos ni adornos innecesarios.",
].join(" ");

export type NarratorEngineOptions = {
  readonly maxNarrationsPerMinute: number;
};

export class NarratorEngine {
  private readonly recentNarrations: Narration[] = [];

  constructor(
    private readonly llm: LlmClient,
    private readonly opts: NarratorEngineOptions,
  ) {}

  async narrate(changes: ReadonlyArray<ObservationChange>): Promise<Narration | null> {
    if (changes.length === 0) return null;
    if (this.isRateLimited()) return null;

    const description = describeChanges(changes);
    const llm = await this.llm.complete({
      system: SYSTEM_PROMPT,
      user: description,
      maxTokens: 60,
      temperature: 0.4,
    });
    if (!llm.ok) return null;
    const line = cleanLine(llm.text);
    if (!line) return null;
    if (this.recentlySaid(line)) return null;

    const narration: Narration = {
      atISO: new Date().toISOString(),
      causes: changes.map((c) => c.kind),
      line,
    };
    this.remember(narration);
    return narration;
  }

  /** Latest narrations, newest first. Capped at 32 to keep memory bounded. */
  recent(limit: number): ReadonlyArray<Narration> {
    return this.recentNarrations
      .slice()
      .reverse()
      .slice(0, Math.max(1, Math.min(32, limit)));
  }

  // ─── internals ────────────────────────────────────────────────

  private isRateLimited(): boolean {
    const cutoff = Date.now() - 60_000;
    const inWindow = this.recentNarrations.filter(
      (n) => new Date(n.atISO).getTime() >= cutoff,
    );
    return inWindow.length >= this.opts.maxNarrationsPerMinute;
  }

  private recentlySaid(line: string): boolean {
    const cutoff = Date.now() - 90_000;
    return this.recentNarrations.some(
      (n) => n.line === line && new Date(n.atISO).getTime() >= cutoff,
    );
  }

  private remember(narration: Narration): void {
    this.recentNarrations.push(narration);
    if (this.recentNarrations.length > 32) this.recentNarrations.shift();
  }
}

/** Compact, prompt-friendly description of changes. Bias to vague language
 *  for titles (so the LLM rephrases instead of reading them verbatim). */
function describeChanges(changes: ReadonlyArray<ObservationChange>): string {
  const parts: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case "window.switched": {
        const fromApp = c.from?.processName ?? "ninguna";
        const toApp = c.to.processName;
        const sameApp = fromApp.toLowerCase() === toApp.toLowerCase();
        if (sameApp) {
          parts.push(`Dal sigue en ${toApp}, cambió de ventana.`);
        } else {
          parts.push(`Dal pasó de ${fromApp} a ${toApp}.`);
        }
        break;
      }
      case "user.went.idle":
        parts.push(`Dal lleva ${Math.round(c.idleForMs / 1000)} s sin teclear ni mover el ratón.`);
        break;
      case "user.returned":
        parts.push(`Dal volvió después de ${Math.round(c.awayForMs / 1000)} s.`);
        break;
      case "process.spiked":
        parts.push(
          `${c.process.name} subió de ${Math.round(c.previousMB)} MB a ${Math.round(c.process.workingSetMB)} MB de RAM.`,
        );
        break;
    }
  }
  return parts.join(" ");
}

function cleanLine(raw: string): string {
  // Strip markdown bullets, surrounding quotes, leading "Lumina:" prefixes.
  let s = raw.trim();
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  s = s.replace(/^[-•]\s*/, "");
  s = s.replace(/^lumina[:：]\s*/i, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}
