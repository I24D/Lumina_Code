/**
 * Entrega una respuesta terminada de Lumina Code a Lumina Start Talk para que la
 * lea en voz alta.
 *
 * Usa el mismo buzón que los hooks de Claude Code y Codex —
 * `POST /voice/claude-response` en el Lumina Windows Bridge— así que las tres
 * fuentes llegan a la voz por el mismo camino y con las mismas reglas de TTL y
 * de cola. Aquí solo cambia el `source`, que es lo que Lumina anuncia.
 *
 * Dispara y olvida. Si el bridge no está levantado, o tarda, o responde error,
 * no pasa absolutamente nada: esto cuelga del final de una respuesta de chat y
 * jamás puede retrasarla ni romperla.
 */

const MAX_CHARS = 6000;

// Por debajo de esto no hay nada que resumir en voz alta ("Hecho.", "Sí.").
const MIN_CHARS = 40;

function bridgeBase(): string {
  const url = process.env.LUMINA_BRIDGE_URL?.trim();
  if (url) {
    return url.replace(/\/+$/, "");
  }
  const port = process.env.LUMINA_BRIDGE_PORT?.trim() || "8765";
  return `http://127.0.0.1:${port}`;
}

export function announceAssistantResponse(text: string): void {
  // Interruptor para quien no quiera que Lumina Code hable por la boca de
  // Start Talk. Las otras dos fuentes se apagan quitando su hook.
  if (process.env.LUMINA_VOICE_ANNOUNCE === "0") {
    return;
  }

  const clean = (text ?? "").trim();
  if (clean.length < MIN_CHARS) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  void fetch(`${bridgeBase()}/voice/claude-response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: clean.slice(0, MAX_CHARS),
      source: "Lumina Code",
    }),
    signal: controller.signal,
  })
    .catch(() => {
      // Bridge apagado o inalcanzable: es el estado normal cuando Start Talk no
      // se está usando. Sin ruido en la consola.
    })
    .finally(() => clearTimeout(timeout));
}
