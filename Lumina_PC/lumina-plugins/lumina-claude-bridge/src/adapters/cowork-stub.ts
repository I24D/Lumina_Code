/**
 * Cowork adapter — STUB.
 *
 * TODO: Cowork está en beta y NO tiene API pública estable a la fecha
 * (2026-06-21). Cuando Anthropic publique un endpoint o SDK oficial,
 * reescribir esta clase implementando ClaudeAdapter sin tocar nada más.
 *
 * Mientras tanto, `available()` siempre retorna false y `send()` retorna
 * una explicación amigable para que Stark Talk pueda decirlo por voz.
 */
import type { AdapterCapabilities, ClaudeAdapter, ClaudeTarget } from "../types.js";

const COWORK_CAPS: AdapterCapabilities = {
  streaming: false,
  toolUse: false,
  vision: false,
  fileAttach: false,
  structuredOutput: false,
};

const COWORK_MESSAGE =
  "Cowork integration pending — Anthropic aún no publicó una API pública estable. " +
  "Usa chat-app o code-cli mientras tanto.";

export class CoworkStubAdapter implements ClaudeAdapter {
  readonly target: ClaudeTarget = "cowork";
  readonly capabilities: AdapterCapabilities = COWORK_CAPS;

  async available(): Promise<boolean> {
    return false;
  }

  async send(): Promise<{ response: string; meta?: Record<string, unknown> }> {
    return {
      response: COWORK_MESSAGE,
      meta: { stub: true, since: "2026-06-21" },
    };
  }
}
