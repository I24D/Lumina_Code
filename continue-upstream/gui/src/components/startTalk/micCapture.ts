/**
 * micCapture.ts — Captura del micrófono dentro del WebView, con AEC real.
 *
 * Por qué aquí y no en core con FFmpeg (que es de donde viene):
 *
 * La cancelación de eco necesita como referencia la señal que se está
 * REPRODUCIENDO. FFmpeg captura del dispositivo y nunca ve lo que suena por los
 * altavoces, así que no puede cancelar la voz de Lumina: solo se podía
 * aproximar comparando energías, y de ahí venía que se cortase a sí misma.
 *
 * Chromium sí tiene esa referencia — la voz de Lumina se reproduce en este
 * mismo WebView (ver `pcmPlayer.ts`) — y aplica su pipeline WebRTC completo:
 * cancelación de eco, supresión de ruido y control automático de ganancia,
 * afinado durante años y muy por encima de lo que hacía el DSP propio.
 *
 * Eso es lo que habilita el full-duplex de verdad: escucharte mientras habla,
 * sin oírse a sí misma.
 *
 * El audio sale como PCM s16le mono a 16 kHz, exactamente el formato que
 * espera Gemini Live, y viaja a core por `startTalk/sendAudio`.
 */

/** Formato que exige la entrada de audio de la Live API. */
export const MIC_SAMPLE_RATE = 16000;
/** Tamaño del bloque que se envía a core (~64 ms a 16 kHz). */
const FRAME_SAMPLES = 1024;

/**
 * Worklet de captura: recibe bloques de 128 muestras a la tasa del contexto,
 * remuestrea a 16 kHz y acumula hasta completar un bloque antes de enviarlo.
 *
 * Va inline y se carga por Blob URL por el mismo motivo que el de reproducción:
 * un asset suelto habría que añadirlo al build de Vite y volver a copiarlo al
 * ensamblar `orb-frontend`, que es justo el paso que se olvida.
 */
const WORKLET_SOURCE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    this.frameSamples = options.processorOptions.frameSamples;
    this.ratio = sampleRate / this.targetRate;
    this.buffer = new Float32Array(this.frameSamples);
    this.filled = 0;
    // Posición fraccionaria dentro del flujo de entrada, para que el
    // remuestreo no acumule deriva entre bloques.
    this.position = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true;
    }

    while (this.position < channel.length) {
      const index = Math.floor(this.position);
      const frac = this.position - index;
      const a = channel[index];
      const b = index + 1 < channel.length ? channel[index + 1] : a;
      this.buffer[this.filled++] = a + (b - a) * frac;
      this.position += this.ratio;

      if (this.filled >= this.frameSamples) {
        const pcm = new Int16Array(this.frameSamples);
        for (let i = 0; i < this.frameSamples; i++) {
          const s = Math.max(-1, Math.min(1, this.buffer[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm, [pcm.buffer]);
        this.filled = 0;
      }
    }
    // Conserva el sobrante fraccionario para el siguiente bloque.
    this.position -= channel.length;
    return true;
  }
}
registerProcessor('lumina-mic-capture', MicCaptureProcessor);
`;

export interface MicCaptureHandlers {
  /** PCM s16le mono a 16 kHz, listo para Gemini Live. */
  onAudio: (pcm: Int16Array) => void;
  onError: (message: string) => void;
}

/** Lo que Chromium acabó aplicando de verdad, según `track.getSettings()`. */
export interface MicCaptureSettings {
  deviceId?: string;
  label: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate?: number;
}

/** Micrófonos disponibles. Las etiquetas exigen permiso ya concedido. */
export async function listMicrophones(): Promise<
  Array<{ deviceId: string; label: string }>
> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Micrófono ${index + 1}`,
    }));
}

export class MicCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private settings?: MicCaptureSettings;

  /**
   * Abre el micrófono con el procesamiento de Chromium activado y empieza a
   * emitir PCM. `deviceId` vacío deja elegir al sistema.
   */
  async start(
    deviceId: string | undefined,
    handlers: MicCaptureHandlers,
  ): Promise<MicCaptureSettings> {
    await this.stop();

    // Estas tres restricciones son el motivo de existir de este módulo. Sin
    // `echoCancellation` no hay full-duplex: el micro recaptura la voz de
    // Lumina por los altavoces y la corta a media respuesta.
    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;

    const track = stream.getAudioTracks()[0];
    if (!track) {
      await this.stop();
      throw new Error("El micrófono no entregó ninguna pista de audio.");
    }

    // Lo pedido no siempre es lo aplicado: un dispositivo puede no soportar
    // AEC. Se consulta lo REAL para poder decirlo en vez de suponerlo.
    const applied = track.getSettings();
    this.settings = {
      deviceId: applied.deviceId,
      label: track.label || "Micrófono",
      echoCancellation: applied.echoCancellation === true,
      noiseSuppression: applied.noiseSuppression === true,
      autoGainControl: applied.autoGainControl === true,
      sampleRate: applied.sampleRate,
    };

    // El contexto va a la tasa nativa del dispositivo: forzar 16 kHz aquí
    // desactiva el procesamiento WebRTC en algunas versiones de Chromium. El
    // remuestreo lo hace el worklet.
    const context = new AudioContext();
    this.context = context;

    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(context, "lumina-mic-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        targetRate: MIC_SAMPLE_RATE,
        frameSamples: FRAME_SAMPLES,
      },
    });
    node.port.onmessage = (event: MessageEvent) => {
      handlers.onAudio(event.data as Int16Array);
    };
    this.node = node;

    const source = context.createMediaStreamSource(stream);
    source.connect(node);
    this.source = source;

    // Si el usuario desconecta el micro, la pista muere y hay que avisar.
    track.addEventListener("ended", () => {
      handlers.onError("El micrófono se desconectó.");
    });

    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    return this.settings;
  }

  /** Lo que Chromium aplicó realmente, o undefined si no está capturando. */
  appliedSettings(): MicCaptureSettings | undefined {
    return this.settings;
  }

  /** True mientras el micrófono esté abierto y la pista viva. */
  isActive(): boolean {
    return Boolean(this.stream?.getAudioTracks().some((t) => t.readyState === "live"));
  }

  /** Reanuda el contexto si el sistema lo suspendió. */
  resumeIfNeeded(): void {
    if (this.context?.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const context = this.context;

    this.node = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.settings = undefined;

    await context?.close().catch(() => undefined);
  }
}
