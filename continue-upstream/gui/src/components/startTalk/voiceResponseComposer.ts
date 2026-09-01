/** Voice-specific presentation layer for text that will be spoken aloud. */

const URL_PATTERN = /https?:\/\/[^\s),>}]+/giu;
const MARKDOWN_LINK = /\[([^\r\n]+?)\]\((https?:\/\/[^)]+)\)/giu;
const CODE_FENCE = /```(?:\w+)?\s*[\s\S]*?```/gu;

/**
 * Keeps the useful prose but does not make TTS pronounce source syntax, huge
 * URLs or code character by character. The original response remains visible
 * in the UI, so this transformation affects speech only.
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
 * Incremental semantic segmenter for classic LLM→TTS pipelines. It releases
 * complete sentences as tokens arrive and bounds latency for punctuation-free
 * model output without cutting in the middle of a word.
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
