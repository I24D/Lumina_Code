/**
 * pcmPlayer.ts — Reproducción de la voz de Lumina con AudioWorklet.
 *
 * Qué reemplaza: antes se creaba un `AudioBufferSourceNode` por cada fragmento
 * recibido y se encadenaban por tiempo absoluto. Funciona, pero tiene tres
 * problemas medidos en este proyecto:
 *
 *  1. La cola solo se podía ESTIMAR (`nextPlaybackTime - currentTime`), y core
 *     depende de ese número para saber si Lumina sigue hablando y mantener el
 *     micrófono cerrado. Si se queda corto, ella se oye a sí misma y se corta.
 *  2. El servidor entrega hasta 3,6x tiempo real y trocea mucho: se midieron
 *     4.755 fragmentos en una sola respuesta. Eso son 4.755 nodos creados,
 *     agendados y recolectados en el hilo principal de React.
 *  3. No había forma de contar los "underrun" (quedarse sin audio a mitad).
 *
 * Aquí el worklet posee un buffer en anillo acotado y va informando de cuántas
 * muestras le quedan. Lo que no cabe se queda en una cola en el hilo principal
 * y se va inyectando según se libera sitio, así la memoria del hilo de audio
 * está acotada pero la cola total sigue siendo exacta y medible.
 *
 * El contexto se crea a 24 kHz (la tasa nativa de Gemini) para que no haya que
 * remuestrear en el camino habitual; si llegara audio a otra tasa se remuestrea
 * en el hilo principal antes de entrar.
 */

/** Tamaño del anillo dentro del worklet. Acota la memoria del hilo de audio. */
const RING_SECONDS = 30;
/** Cada cuánto informa el worklet de su nivel de llenado. */
const STATUS_INTERVAL_MS = 100;
/** Tasa nativa del audio de salida de Gemini Live. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

/**
 * Código del worklet. Va como texto y se carga por Blob URL a propósito: así no
 * hay que añadir un asset suelto al build de Vite ni copiarlo aparte al
 * ensamblar `orb-frontend`, que es justo el tipo de paso que se olvida y hace
 * que el exe embeba una versión vieja sin que nada falle visiblemente.
 */
const WORKLET_SOURCE = `
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const capacity = options.processorOptions.capacity;
    this.buffer = new Float32Array(capacity);
    this.capacity = capacity;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.queued = 0;
    this.underruns = 0;
    this.framesSinceStatus = 0;
    this.statusEvery = options.processorOptions.statusEvery;
    // Silencio deliberado tras un underrun: sin esto se repetiría la última
    // muestra y se oiría un chasquido.
    this.draining = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'push') {
        this.write(data.samples);
      } else if (data.type === 'flush') {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.queued = 0;
        this.draining = false;
        this.postStatus();
      }
    };
  }

  write(samples) {
    const free = this.capacity - this.queued;
    const count = Math.min(samples.length, free);
    for (let i = 0; i < count; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.queued += count;
  }

  postStatus() {
    this.port.postMessage({
      type: 'status',
      queued: this.queued,
      free: this.capacity - this.queued,
      underruns: this.underruns,
    });
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel) {
      return true;
    }
    const frames = channel.length;

    if (this.queued === 0) {
      channel.fill(0);
      if (!this.draining) {
        this.underruns += 1;
        this.draining = true;
      }
    } else {
      this.draining = false;
      const count = Math.min(frames, this.queued);
      for (let i = 0; i < count; i++) {
        channel[i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
      if (count < frames) {
        channel.fill(0, count);
      }
      this.queued -= count;
    }

    this.framesSinceStatus += frames;
    if (this.framesSinceStatus >= this.statusEvery) {
      this.framesSinceStatus = 0;
      this.postStatus();
    }
    return true;
  }
}
registerProcessor('lumina-pcm-player', PcmPlayerProcessor);
`;

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as Window &
    typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
}

/** PCM s16le en base64 → Float32 normalizado. */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const sampleCount = binary.length >> 1;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    // s16 little-endian con signo.
    const value = (hi << 8) | lo;
    out[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  return out;
}

/**
 * Remuestreo lineal. Solo se usa si llega audio a una tasa distinta de la del
 * contexto; en la ruta normal (24 kHz) no se toca nada.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i / ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export interface PcmPlayerStatus {
  /** Milisegundos de voz pendientes de sonar, worklet + cola del hilo principal. */
  remainingMs: number;
  underruns: number;
}

export class PcmPlayer {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private moduleUrl?: string;
  private starting?: Promise<void>;

  /** Lo que el worklet no aceptó todavía por falta de sitio. */
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private workletQueued = 0;
  private workletFree = 0;
  private underrunCount = 0;

  static isSupported(): boolean {
    const Ctor = getAudioContextConstructor();
    return Boolean(Ctor && typeof AudioWorkletNode !== "undefined");
  }

  /** Arranca el contexto y el worklet. Idempotente y seguro concurrentemente. */
  async ensureStarted(): Promise<void> {
    if (this.node) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = (async () => {
      const Ctor = getAudioContextConstructor();
      if (!Ctor) {
        throw new Error("AudioContext no disponible en este WebView.");
      }
      // 24 kHz = tasa nativa de Gemini: evita remuestrear en el camino normal.
      const context = new Ctor({ sampleRate: GEMINI_OUTPUT_SAMPLE_RATE });
      const blob = new Blob([WORKLET_SOURCE], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const capacity = Math.round(context.sampleRate * RING_SECONDS);
      const node = new AudioWorkletNode(context, "lumina-pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          capacity,
          statusEvery: Math.round(
            (context.sampleRate * STATUS_INTERVAL_MS) / 1000,
          ),
        },
      });
      this.workletFree = capacity;

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as {
          type: string;
          queued?: number;
          free?: number;
          underruns?: number;
        };
        if (data.type === "status") {
          // Autoritativo: corrige la contabilidad optimista de `drainPending`,
          // que descuenta el sitio al enviar para poder encadenar fragmentos
          // seguidos sin esperar a este mensaje.
          this.workletQueued = data.queued ?? 0;
          this.workletFree = data.free ?? 0;
          this.underrunCount = data.underruns ?? this.underrunCount;
          // Se liberó sitio: intenta colocar lo retenido.
          this.drainPending();
        }
      };

      node.connect(context.destination);
      this.context = context;
      this.node = node;
      this.moduleUrl = url;
    })();

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Encola un fragmento PCM s16 base64 para reproducirlo. */
  async play(base64: string, sampleRate: number): Promise<void> {
    await this.ensureStarted();
    const context = this.context;
    if (!context) {
      return;
    }
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    let samples = pcm16Base64ToFloat32(base64);
    if (sampleRate && sampleRate !== context.sampleRate) {
      samples = resampleLinear(samples, sampleRate, context.sampleRate);
    }
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    this.drainPending();
  }

  /** Empuja al worklet todo lo que quepa, conservando el orden. */
  private drainPending(): void {
    const node = this.node;
    if (!node) {
      return;
    }
    while (this.pending.length > 0 && this.workletFree > 0) {
      const head = this.pending[0];
      if (head.length <= this.workletFree) {
        this.pending.shift();
        this.pendingSamples -= head.length;
        this.workletFree -= head.length;
        node.port.postMessage({ type: "push", samples: head }, [head.buffer]);
      } else {
        // Solo cabe un trozo: se parte y se conserva el resto para después.
        const head2 = head.subarray(0, this.workletFree);
        const chunk = new Float32Array(head2);
        const rest = new Float32Array(head.subarray(this.workletFree));
        this.pending[0] = rest;
        this.pendingSamples -= chunk.length;
        this.workletFree = 0;
        node.port.postMessage({ type: "push", samples: chunk }, [chunk.buffer]);
      }
    }
  }

  /** Corta la reproducción y tira todo lo pendiente. */
  stop(): void {
    this.pending = [];
    this.pendingSamples = 0;
    this.workletQueued = 0;
    this.node?.port.postMessage({ type: "flush" });
  }

  /** Voz que queda por sonar: la del worklet más la retenida aquí. */
  status(): PcmPlayerStatus {
    const rate = this.context?.sampleRate ?? GEMINI_OUTPUT_SAMPLE_RATE;
    const samples = this.workletQueued + this.pendingSamples;
    return {
      remainingMs: Math.round((samples / rate) * 1000),
      underruns: this.underrunCount,
    };
  }

  /** Reanuda el contexto si el WebView o el sistema lo suspendió. */
  resumeIfNeeded(): void {
    const context = this.context;
    if (context && context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.stop();
    this.node?.disconnect();
    this.node = undefined;
    if (this.moduleUrl) {
      this.moduleUrl = undefined;
    }
    const context = this.context;
    this.context = undefined;
    await context?.close().catch(() => undefined);
  }
}
