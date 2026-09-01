/**
 * speechText.ts — Cómo se dice en voz alta lo que se escribió para leerse.
 *
 * Una respuesta escrita y una hablada no son la misma cosa. En pantalla un
 * bloque de código y una URL de doscientos caracteres son útiles; leídos en alto
 * son ruido de un minuto que además tapa la respuesta de verdad. Aquí se separa
 * lo uno de lo otro: el texto original sigue entero en la interfaz y solo la voz
 * recibe esta versión.
 *
 * No importa nada de Node a propósito. Lo usan el webview del orbe y el
 * proveedor de voz por tuberías dentro de core, y un import de valor que
 * arrastre `fs`/`os`/`dotenv` deja la ventana de Start Talk en negro.
 */

const URL_PATTERN = /https?:\/\/[^\s),>}]+/giu;
const MARKDOWN_LINK = /\[([^\r\n]+?)\]\((https?:\/\/[^)]+)\)/giu;
const CODE_FENCE = /```(?:\w+)?\s*[\s\S]*?```/gu;

/**
 * Conserva la prosa útil, pero no hace que el TTS pronuncie sintaxis, URLs
 * enormes o código carácter a carácter. La respuesta original sigue visible en
 * la interfaz: esta transformación solo afecta a lo que se dice.
 */
export function composeVoiceResponse(text: string): string {
  let mentionedLink = false;
  let mentionedCode = false;
  let output = String(text ?? "").replace(CODE_FENCE, () => {
    mentionedCode = true;
    return " ";
  });
  output = output.replace(MARKDOWN_LINK, (_match, label: string) => {
    mentionedLink = true;
    return label;
  });
  output = output.replace(URL_PATTERN, () => {
    mentionedLink = true;
    return "";
  });
  output = output
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/\|/gu, ", ")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  const notes = [
    mentionedCode ? "Te dejé el código en pantalla." : "",
    mentionedLink ? "Te dejé los enlaces en pantalla." : "",
  ].filter(Boolean);
  return [output, ...notes].filter(Boolean).join(" ");
}

/**
 * Segmentador incremental para la tubería LLM→TTS.
 *
 * Sin él habría que esperar a que el modelo terminara de escribir para empezar
 * a hablar, que es justo la latencia que la tubería tiene que evitar: en cuanto
 * hay una oración completa se puede sintetizar y sonar mientras el modelo sigue
 * generando el resto.
 *
 * El tope de caracteres existe porque hay modelos que escriben párrafos enteros
 * sin un punto. Cortar por la última palabra completa suena a pausa; esperar a
 * un punto que no llega suena a que Lumina se ha quedado muda.
 */
export class StreamingSentenceSegmenter {
  private buffer = "";

  constructor(private readonly maxBufferedChars = 220) {}

  push(chunk: string): string[] {
    this.buffer += String(chunk ?? "");
    const ready: string[] = [];
    while (true) {
      const sentence = this.nextSentenceBoundary();
      if (sentence <= 0) {
        break;
      }
      const segment = this.buffer.slice(0, sentence).trim();
      this.buffer = this.buffer.slice(sentence).trimStart();
      if (segment) {
        ready.push(composeVoiceResponse(segment));
      }
    }
    return ready.filter(Boolean);
  }

  flush(): string[] {
    const tail = composeVoiceResponse(this.buffer);
    this.buffer = "";
    return tail ? [tail] : [];
  }

  private nextSentenceBoundary(): number {
    const punctuation = this.buffer.search(/[.!?](?:\s|$)/u);
    if (punctuation >= 0) {
      return punctuation + 1;
    }
    if (this.buffer.length <= this.maxBufferedChars) {
      return -1;
    }
    const cut = this.buffer.lastIndexOf(" ", this.maxBufferedChars);
    return cut > this.maxBufferedChars * 0.6 ? cut : -1;
  }
}
