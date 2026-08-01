/**
 * VoiceActivityGate
 *
 * Motor de detección de voz (VAD) con barge-in dúplex-aware para Start Talk.
 *
 * Problema que resuelve: el micrófono se captura en continuo y, si reenviamos
 * cada frame a Gemini Live, su VAD automática interrumpe a Lumina en cuanto el
 * micro recaptura su propia voz (eco) o cualquier ruido/muletilla. Resultado:
 * Lumina se corta a sí misma y suena tartamuda.
 *
 * Este gate desactiva de facto ese comportamiento: se coloca entre el PCM del
 * micrófono y la sesión Live y decide, frame a frame, qué reenviar y cuándo
 * abrir/cerrar el turno del usuario mediante señales de actividad manuales
 * (`activityStart` / `activityEnd`).
 *
 * Comportamiento clave (dúplex-aware):
 * - Idle / escuchando: umbral normal y arranque corto → responde ágil.
 * - Mientras Lumina HABLA: sigue analizando en segundo plano, pero exige voz
 *   real, sostenida y con más energía antes de abrir turno (barge-in). Así el
 *   eco de su propia voz y las muletillas cortas NO la interrumpen; solo una
 *   interrupción deliberada del usuario la corta.
 *
 * No usa ningún modelo de IA local: es DSP puro (energía RMS + histéresis).
 */

export interface VoiceActivityGateCallbacks {
  /** Marca el inicio del turno del usuario (barge-in). Se llama una sola vez por locución. */
  onActivityStart: () => void;
  /** Reenvía un frame de audio (PCM s16le mono) a la sesión Live. */
  onAudio: (pcm: Buffer) => void;
  /** Cierra el turno del usuario. Dispara la respuesta del modelo. */
  onActivityEnd: () => void;
  /** Cambio de estado observable (para UI/telemetría). Opcional. */
  onSpeechState?: (speaking: boolean) => void;
}

export interface VoiceActivityGateOptions {
  sampleRate: number;
  frameMs: number;
  /** Piso de ruido inicial (RMS s16). Se adapta con el ambiente. */
  initialNoiseFloor: number;
  minNoiseFloor: number;
  maxNoiseFloor: number;
  /** Multiplicador del piso de ruido para el umbral de voz en modo normal. */
  startMultiplier: number;
  /** Ratio del umbral usado para sostener un posible inicio entre silabas. */
  startContinuationRatio: number;
  /** Multiplicador (más alto) mientras Lumina habla: barge-in solo con voz clara. */
  bargeStartMultiplier: number;
  /** Umbral RMS absoluto mínimo en modo normal. */
  absoluteFloor: number;
  /** Umbral RMS absoluto mínimo mientras Lumina habla. */
  bargeAbsoluteFloor: number;
  /** Duración de voz sostenida necesaria para abrir turno en modo normal (ms). */
  startSustainMsIdle: number;
  /** Duración de voz sostenida necesaria para interrumpir a Lumina (ms). */
  startSustainMsBarge: number;
  /** Silencio necesario para cerrar el turno del usuario (ms). */
  endSilenceMs: number;
  /** Pre-roll retenido para no perder el ataque de la primera palabra (ms). */
  preRollMs: number;
  /** Velocidad de adaptacion cuando el ambiente se vuelve mas silencioso. */
  noiseFallAlpha: number;
  /** Velocidad conservadora de adaptacion cuando aumenta el ruido. */
  noiseRiseAlpha: number;
  /** Limite de subida por actualizacion para no aprender voz como ruido. */
  maxNoiseRiseRatio: number;
  /** Margen extra tras el fin estimado de reproducción para seguir tratándolo como "hablando" (ms). */
  playbackTailMs: number;
  /**
   * Half-duplex mode: while Lumina is audibly speaking, ignore the microphone
   * ENTIRELY so her own voice (speaker echo) can never open a turn. This trades
   * away barge-in for a guaranteed no-self-listening loop. When false, the
   * duplex-aware barge-in behaviour (higher thresholds while she speaks) applies.
   */
  halfDuplex: boolean;
}

export const DEFAULT_GATE_OPTIONS: VoiceActivityGateOptions = {
  sampleRate: 16000,
  frameMs: 20,
  initialNoiseFloor: 150,
  minNoiseFloor: 60,
  maxNoiseFloor: 2000,
  startMultiplier: 2.2,
  startContinuationRatio: 0.72,
  bargeStartMultiplier: 6.0,
  absoluteFloor: 220,
  bargeAbsoluteFloor: 620,
  startSustainMsIdle: 100,
  startSustainMsBarge: 450,
  endSilenceMs: 650,
  preRollMs: 500,
  noiseFallAlpha: 0.08,
  noiseRiseAlpha: 0.04,
  maxNoiseRiseRatio: 1.35,
  playbackTailMs: 250,
  halfDuplex: false,
};

type GateState = "idle" | "speaking";

export class VoiceActivityGate {
  private readonly opts: VoiceActivityGateOptions;
  private readonly callbacks: VoiceActivityGateCallbacks;
  private readonly frameBytes: number;

  private residual: Buffer = Buffer.alloc(0);
  private state: GateState = "idle";
  private noiseFloor: number;
  private candidateMs = 0;
  private silenceMs = 0;

  /** Ring buffer de frames recientes para el pre-roll. */
  private preRoll: Buffer[] = [];
  private preRollMsHeld = 0;

  /** Marca temporal (ms epoch) hasta la que consideramos que Lumina sigue sonando. */
  private playbackDeadline = 0;

  /** Reloj inyectable para tests deterministas. */
  private readonly now: () => number;

  constructor(
    callbacks: VoiceActivityGateCallbacks,
    options?: Partial<VoiceActivityGateOptions>,
    now: () => number = () => Date.now(),
  ) {
    this.callbacks = callbacks;
    this.opts = { ...DEFAULT_GATE_OPTIONS, ...(options ?? {}) };
    this.now = now;
    this.noiseFloor = this.opts.initialNoiseFloor;
    this.frameBytes =
      Math.floor((this.opts.sampleRate * this.opts.frameMs) / 1000) * 2;
  }

  /**
   * Informa que el modelo emitió audio de salida. Extiende la ventana durante la
   * que tratamos la entrada del micro como potencial eco (modo barge-in estricto).
   */
  noteAssistantAudio(byteLength: number, sampleRate = 24000): void {
    const durationMs = (byteLength / 2 / sampleRate) * 1000;
    const from = Math.max(this.now(), this.playbackDeadline);
    this.playbackDeadline = from + durationMs;
  }

  /** Fuerza (des)activar el estado "Lumina hablando". */
  setAssistantSpeaking(active: boolean): void {
    if (active) {
      this.playbackDeadline = Math.max(
        this.playbackDeadline,
        this.now() + this.opts.frameMs,
      );
    } else {
      this.playbackDeadline = 0;
    }
  }

  private isAssistantActive(): boolean {
    if (this.playbackDeadline <= 0) {
      return false;
    }
    return this.now() < this.playbackDeadline + this.opts.playbackTailMs;
  }

  /** Procesa un chunk arbitrario de PCM s16le mono. */
  process(chunk: Buffer): void {
    const buf =
      this.residual.length > 0 ? Buffer.concat([this.residual, chunk]) : chunk;

    let offset = 0;
    while (offset + this.frameBytes <= buf.length) {
      this.processFrame(buf.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }

    this.residual =
      offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  private processFrame(frame: Buffer): void {
    const rms = rmsOfS16(frame);
    const duplex = this.isAssistantActive();

    // Half-duplex: while Lumina is audibly speaking, drop the microphone
    // entirely. Her own voice (speaker echo) can never open a turn, so she
    // cannot auto-answer herself. Listening resumes automatically once the
    // playback window (+ tail) elapses.
    if (this.opts.halfDuplex && duplex) {
      if (this.state === "speaking") {
        // A user turn was open when she started speaking: close it cleanly.
        this.closeTurn();
      }
      this.candidateMs = 0;
      // Do NOT keep her echo in the pre-roll, or it would leak into the next
      // user turn the moment she stops speaking.
      this.clearPreRoll();
      return;
    }

    const multiplier = duplex
      ? this.opts.bargeStartMultiplier
      : this.opts.startMultiplier;
    const absFloor = duplex
      ? this.opts.bargeAbsoluteFloor
      : this.opts.absoluteFloor;
    const baseThreshold = Math.max(absFloor, this.noiseFloor * multiplier);
    // Once speech is a candidate, use a lower continuation threshold. Natural
    // speech contains short low-energy consonants and gaps that should not erase
    // the stronger syllables already observed.
    const threshold =
      this.state === "idle" && this.candidateMs > 0
        ? baseThreshold * this.opts.startContinuationRatio
        : baseThreshold;
    const voiced = rms >= threshold;

    this.pushPreRoll(frame);

    if (this.state === "idle") {
      if (voiced) {
        this.candidateMs += this.opts.frameMs;
        const sustainNeeded = duplex
          ? this.opts.startSustainMsBarge
          : this.opts.startSustainMsIdle;
        if (this.candidateMs >= sustainNeeded) {
          this.openTurn();
        }
      } else {
        // Decaimiento rápido: tolera micro-huecos sin resetear del todo.
        // Keep a leaky candidate across brief consonants and syllabic gaps. The
        // noise estimate stays frozen until the candidate fully expires, so soft
        // speech cannot raise its own threshold.
        this.candidateMs = Math.max(
          0,
          this.candidateMs - this.opts.frameMs,
        );
        if (this.candidateMs === 0) {
          this.adaptNoiseFloor(rms);
        }
      }
      return;
    }

    // state === "speaking": ya cedimos el turno al usuario.
    this.callbacks.onAudio(frame);
    if (voiced) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.opts.frameMs;
      this.adaptNoiseFloor(rms);
      if (this.silenceMs >= this.opts.endSilenceMs) {
        this.closeTurn();
      }
    }
  }

  private openTurn(): void {
    this.state = "speaking";
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.callbacks.onActivityStart();
    this.callbacks.onSpeechState?.(true);
    // Vaciar el pre-roll para no perder el ataque de la primera palabra.
    for (const frame of this.preRoll) {
      this.callbacks.onAudio(frame);
    }
    this.clearPreRoll();
  }

  private closeTurn(): void {
    this.state = "idle";
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.callbacks.onActivityEnd();
    this.callbacks.onSpeechState?.(false);
  }

  /**
   * Reinicia el gate. Si hay un turno abierto lo cierra (para no dejar actividad
   * colgada al parar la captura o al reconectar).
   */
  reset(flush = true): void {
    if (this.state === "speaking" && flush) {
      this.callbacks.onActivityEnd();
      this.callbacks.onSpeechState?.(false);
    }
    this.state = "idle";
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.residual = Buffer.alloc(0);
    this.clearPreRoll();
  }

  private adaptNoiseFloor(rms: number): void {
    const rising = rms > this.noiseFloor;
    const alpha = rising
      ? this.opts.noiseRiseAlpha
      : this.opts.noiseFallAlpha;
    // Learn rising ambience gradually and in bounded steps. A sudden voice onset
    // can open the gate instead of being absorbed as the new noise floor.
    const target = rising
      ? Math.min(rms, this.noiseFloor * this.opts.maxNoiseRiseRatio)
      : rms;
    const next = this.noiseFloor * (1 - alpha) + target * alpha;
    this.noiseFloor = Math.min(
      this.opts.maxNoiseFloor,
      Math.max(this.opts.minNoiseFloor, next),
    );
  }

  private pushPreRoll(frame: Buffer): void {
    this.preRoll.push(Buffer.from(frame));
    this.preRollMsHeld += this.opts.frameMs;
    while (this.preRollMsHeld > this.opts.preRollMs && this.preRoll.length > 0) {
      this.preRoll.shift();
      this.preRollMsHeld -= this.opts.frameMs;
    }
  }

  private clearPreRoll(): void {
    this.preRoll = [];
    this.preRollMsHeld = 0;
  }
}

/** RMS de un frame PCM s16le (little-endian, mono). */
export function rmsOfS16(frame: Buffer): number {
  const sampleCount = Math.floor(frame.length / 2);
  if (sampleCount === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}
