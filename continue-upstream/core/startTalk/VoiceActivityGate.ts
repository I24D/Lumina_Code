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
 * Comportamiento clave:
 * - Idle / escuchando: umbral normal y arranque corto → responde ágil.
 * - Mientras Lumina HABLA (`bargeMode`): "keyword" (por defecto) solo la corta
 *   con una orden corta y fuerte tipo "para"/"espera"; "energy" permite el
 *   barge-in clásico por voz sostenida; "off" la hace incortable.
 * - En una sala con varias voces a la vez el turno se cierra igual, por techo
 *   de duración o por el hueco más profundo disponible. Sin esto el turno no
 *   se cierra NUNCA y Gemini jamás recibe permiso para responder: Lumina
 *   parece muda. Ver `maxTurnMs` / `softBoundary*`.
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
  /**
   * Cambia cuando el entorno pasa a tener (o dejar de tener) varias voces
   * solapadas de forma sostenida. Sirve para que Lumina sepa que está en un
   * grupo y aplique sus reglas de cuándo intervenir. Opcional.
   */
  onEnvironmentChange?: (crowded: boolean) => void;
}

/** Qué puede interrumpir a Lumina mientras habla. */
export type BargeInMode = "keyword" | "energy" | "off";

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
   * Qué puede cortar a Lumina mientras habla:
   * - "keyword": solo una interjección corta y claramente más fuerte que el eco
   *   de su propia voz ("¡para!", "espera"). Ni la bulla ni su eco la cortan.
   * - "energy": barge-in clásico por voz sostenida y con más energía.
   * - "off": half-duplex estricto, el micro se ignora por completo.
   */
  bargeMode: BargeInMode;
  /**
   * Cuánto debe superar la interjección al nivel del propio eco para contar.
   * Mientras Lumina suena, el micro SIEMPRE la está oyendo por los altavoces:
   * un umbral absoluto no distingue su eco de tu voz, pero un salto claro por
   * encima del nivel de eco medido sí.
   */
  bargeOverEchoRatio: number;
  /** Duración mínima de la orden corta que puede cortarla (ms). */
  stopWordMinMs: number;
  /** Duración máxima de esa orden: por encima ya es habla continua, no una orden. */
  stopWordMaxMs: number;
  /** Caída por debajo del umbral que confirma que la orden terminó (ms). */
  stopWordSilenceMs: number;
  /** Suavizado del nivel de eco medido mientras Lumina habla (0..1). */
  echoBaselineAlpha: number;
  /**
   * Techo duro de un turno abierto (ms). Sin esto, en una sala con varias
   * personas hablando el silencio de cierre no llega nunca y el turno queda
   * abierto para siempre: Gemini no responde y se transmite audio sin parar.
   */
  maxTurnMs: number;
  /**
   * A partir de aquí se acepta cerrar el turno en un hueco RELATIVO (una bajada
   * de energía respecto al pico del turno) en vez de exigir silencio real. Es
   * lo que da límites de turno naturales cuando el ruido de fondo nunca calla.
   */
  softBoundaryAfterMs: number;
  /** Cuánto debe bajar la energía respecto al pico del turno para valer como hueco. */
  softBoundaryRatio: number;
  /** Cuánto debe durar ese hueco para cerrar el turno (ms). */
  softBoundarySilenceMs: number;
  /** Ventana en la que se mide si el entorno tiene voces solapadas (ms). */
  crowdedWindowMs: number;
  /** Fracción de frames con voz dentro de la ventana para declararlo "con gente". */
  crowdedVoicedRatio: number;
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
  bargeMode: "keyword",
  bargeOverEchoRatio: 2.6,
  stopWordMinMs: 240,
  stopWordMaxMs: 1_100,
  stopWordSilenceMs: 200,
  echoBaselineAlpha: 0.05,
  maxTurnMs: 12_000,
  softBoundaryAfterMs: 3_500,
  softBoundaryRatio: 0.38,
  softBoundarySilenceMs: 260,
  crowdedWindowMs: 6_000,
  crowdedVoicedRatio: 0.85,
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

  /** Duración del turno abierto y pico de energía observado en él. */
  private turnMs = 0;
  private turnPeakRms = 0;
  /** Duración del hueco relativo en curso (cierre suave en entornos ruidosos). */
  private dipMs = 0;

  /** Detector de interjección corta ("¡para!") mientras Lumina habla. */
  private stopWordVoicedMs = 0;
  private stopWordSilenceMs = 0;
  private stopWordArmed = false;
  private stopWordFrames: Buffer[] = [];
  /** Ráfaga ya descartada por larga; no se reevalúa hasta que baje la energía. */
  private stopWordLockedOut = false;
  /** Nivel que el micro capta de la propia voz de Lumina por los altavoces. */
  private echoBaseline = 0;
  /** Voz sostenida acumulada en modo de barge-in por energía. */
  private bargeCandidateMs = 0;

  /** Ventana deslizante para saber si hay varias voces solapadas. */
  private crowdWindow: boolean[] = [];
  private crowdVoicedCount = 0;
  private crowded = false;

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
   * que tratamos la entrada del micro como potencial eco.
   *
   * Es solo una ESTIMACIÓN por hora de llegada: el servidor entrega el audio
   * hasta 3x más rápido que el tiempo real, así que esto adelanta la ventana
   * correctamente pero no sabe si la reproducción real se atrasó o se suspendió.
   * La verdad la da `setPlaybackRemaining`, que manda la GUI.
   */
  noteAssistantAudio(byteLength: number, sampleRate = 24000): void {
    const durationMs = (byteLength / 2 / sampleRate) * 1000;
    const from = Math.max(this.now(), this.playbackDeadline);
    this.playbackDeadline = from + durationMs;
  }

  /**
   * Cuánto audio le queda REALMENTE por sonar a Lumina, según la cola de
   * reproducción de la GUI. Es autoritativo: si la reproducción se suspendió,
   * alarga la ventana; si la cortaron, la cierra en el acto.
   */
  setPlaybackRemaining(remainingMs: number): void {
    this.playbackDeadline =
      remainingMs > 0 ? this.now() + remainingMs : 0;
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

  /** True cuando hay varias voces solapadas de forma sostenida. */
  isCrowded(): boolean {
    return this.crowded;
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

    if (duplex) {
      this.handleAssistantSpeakingFrame(frame, rms);
      return;
    }

    this.clearStopWordState();
    // El nivel de eco solo tiene sentido mientras ella suena: se reaprende
    // desde cero en cada intervención suya.
    this.echoBaseline = 0;
    this.bargeCandidateMs = 0;

    const baseThreshold = Math.max(
      this.opts.absoluteFloor,
      this.noiseFloor * this.opts.startMultiplier,
    );
    // Once speech is a candidate, use a lower continuation threshold. Natural
    // speech contains short low-energy consonants and gaps that should not erase
    // the stronger syllables already observed.
    const threshold =
      this.state === "idle" && this.candidateMs > 0
        ? baseThreshold * this.opts.startContinuationRatio
        : baseThreshold;
    const voiced = rms >= threshold;

    this.trackCrowd(voiced);
    this.pushPreRoll(frame);

    if (this.state === "idle") {
      if (voiced) {
        this.candidateMs += this.opts.frameMs;
        if (this.candidateMs >= this.opts.startSustainMsIdle) {
          this.openTurn();
        }
      } else {
        // Decaimiento rápido: tolera micro-huecos sin resetear del todo.
        // Keep a leaky candidate across brief consonants and syllabic gaps. The
        // noise estimate stays frozen until the candidate fully expires, so soft
        // speech cannot raise its own threshold.
        this.candidateMs = Math.max(0, this.candidateMs - this.opts.frameMs);
        if (this.candidateMs === 0) {
          this.adaptNoiseFloor(rms);
        }
      }
      return;
    }

    // state === "speaking": ya cedimos el turno al usuario.
    this.callbacks.onAudio(frame);
    this.turnMs += this.opts.frameMs;
    this.turnPeakRms = Math.max(this.turnPeakRms, rms);

    if (voiced) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.opts.frameMs;
      this.adaptNoiseFloor(rms);
      if (this.silenceMs >= this.opts.endSilenceMs) {
        this.closeTurn();
        return;
      }
    }

    // Entornos con varias voces: el silencio real de `endSilenceMs` puede no
    // llegar jamás. Cerramos en el hueco relativo más profundo disponible y,
    // como último recurso, por techo de duración. Sin esto Gemini nunca recibe
    // el turno y Lumina se queda escuchando indefinidamente.
    if (rms < this.turnPeakRms * this.opts.softBoundaryRatio) {
      this.dipMs += this.opts.frameMs;
    } else {
      this.dipMs = 0;
    }

    const canUseSoftBoundary = this.turnMs >= this.opts.softBoundaryAfterMs;
    if (canUseSoftBoundary && this.dipMs >= this.opts.softBoundarySilenceMs) {
      this.closeTurn();
      return;
    }

    if (this.turnMs >= this.opts.maxTurnMs) {
      this.closeTurn();
    }
  }

  /**
   * Frame recibido mientras Lumina está sonando.
   *
   * El problema de fondo: mientras ella habla el micro la está oyendo por los
   * altavoces SIEMPRE, así que un umbral absoluto no distingue su eco de tu
   * voz. Aquí medimos continuamente el nivel de ese eco y solo aceptamos como
   * interrupción un salto claro por encima de él (`bargeOverEchoRatio`) que
   * además sea CORTO (entre `stopWordMinMs` y `stopWordMaxMs`): el perfil de
   * una interjección como "¡para!". Su propio eco y la bulla de una sala son
   * continuos, así que se pasan del máximo y quedan descartados.
   *
   * Ojo: esto NO reconoce la palabra literal — para eso haría falta ASR local,
   * que no tenemos. Reconoce el gesto acústico de cortar a alguien.
   */
  private handleAssistantSpeakingFrame(frame: Buffer, rms: number): void {
    if (this.state === "speaking") {
      // Había un turno abierto cuando ella empezó a hablar: ciérralo limpio.
      this.closeTurn();
    }
    this.candidateMs = 0;
    // Su eco NO entra al pre-roll: se filtraría al siguiente turno del usuario
    // en cuanto deje de hablar.
    this.clearPreRoll();

    if (this.opts.bargeMode === "off") {
      this.clearStopWordState();
      return;
    }

    if (this.opts.bargeMode === "energy") {
      const energyThreshold = Math.max(
        this.opts.bargeAbsoluteFloor,
        this.noiseFloor * this.opts.bargeStartMultiplier,
      );
      if (rms >= energyThreshold) {
        this.bargeCandidateMs += this.opts.frameMs;
        if (this.bargeCandidateMs >= this.opts.startSustainMsBarge) {
          this.bargeCandidateMs = 0;
          this.openTurn();
        }
      } else {
        this.bargeCandidateMs = 0;
      }
      return;
    }

    // bargeMode === "keyword". La referencia es el nivel del propio eco, que se
    // siembra con el primer frame de su intervención: un umbral absoluto no
    // sirve porque el volumen del eco depende de los altavoces y del AGC.
    if (this.echoBaseline <= 0) {
      this.echoBaseline = rms;
    }
    const threshold = Math.max(
      this.opts.bargeAbsoluteFloor,
      this.echoBaseline * this.opts.bargeOverEchoRatio,
    );
    const voiced = rms >= threshold;

    // La referencia solo aprende de lo que NO es un salto. Así un grito no se
    // absorbe a sí mismo dentro de la referencia y deja de ser detectable.
    if (!voiced) {
      const alpha = this.opts.echoBaselineAlpha;
      this.echoBaseline = this.echoBaseline * (1 - alpha) + rms * alpha;
    }

    if (voiced) {
      if (this.stopWordLockedOut) {
        // Ya se descartó esta ráfaga por larga. Mientras siga sonando fuerte no
        // se vuelve a evaluar: si no, una parrafada se trocearía en trozos del
        // tamaño de una orden y acabaría colando.
        return;
      }
      if (this.stopWordSilenceMs > 0) {
        // Volvió a subir antes de confirmarse el final: no era una interjección
        // corta, es habla continua. Se descarta.
        this.resetStopWordDetector();
      }
      this.stopWordVoicedMs += this.opts.frameMs;
      this.stopWordFrames.push(Buffer.from(frame));
      this.stopWordArmed =
        this.stopWordVoicedMs >= this.opts.stopWordMinMs &&
        this.stopWordVoicedMs <= this.opts.stopWordMaxMs;
      if (this.stopWordVoicedMs > this.opts.stopWordMaxMs) {
        // Demasiado larga para ser una orden: es conversación o su propio eco.
        this.resetStopWordDetector();
        this.stopWordLockedOut = true;
      }
      return;
    }

    // Volvió a bajar: la ráfaga terminó y se puede volver a evaluar.
    this.stopWordLockedOut = false;

    if (!this.stopWordArmed) {
      this.resetStopWordDetector();
      return;
    }

    this.stopWordSilenceMs += this.opts.frameMs;
    if (this.stopWordSilenceMs < this.opts.stopWordSilenceMs) {
      return;
    }

    // Interjección corta y claramente por encima del eco: la cortamos y le
    // mandamos lo que se dijo para que responda a ello.
    const spoken = this.stopWordFrames;
    this.resetStopWordDetector();
    this.state = "speaking";
    this.silenceMs = 0;
    this.turnMs = 0;
    this.turnPeakRms = 0;
    this.dipMs = 0;
    this.callbacks.onActivityStart();
    this.callbacks.onSpeechState?.(true);
    for (const buffered of spoken) {
      this.callbacks.onAudio(buffered);
      this.turnMs += this.opts.frameMs;
    }
  }

  private resetStopWordDetector(): void {
    this.stopWordVoicedMs = 0;
    this.stopWordSilenceMs = 0;
    this.stopWordArmed = false;
    this.stopWordFrames = [];
  }

  /** Reset completo, incluido el cerrojo anti-parrafada. */
  private clearStopWordState(): void {
    this.resetStopWordDetector();
    this.stopWordLockedOut = false;
  }

  /**
   * Mantiene la ventana deslizante de "cuánto de este rato ha tenido voz".
   * Una proporción muy alta y sostenida no es una persona hablando (que hace
   * pausas), es una sala con varias voces solapadas.
   */
  private trackCrowd(voiced: boolean): void {
    const capacity = Math.max(
      1,
      Math.floor(this.opts.crowdedWindowMs / this.opts.frameMs),
    );
    this.crowdWindow.push(voiced);
    if (voiced) {
      this.crowdVoicedCount += 1;
    }
    while (this.crowdWindow.length > capacity) {
      if (this.crowdWindow.shift()) {
        this.crowdVoicedCount -= 1;
      }
    }

    if (this.crowdWindow.length < capacity) {
      return;
    }

    const ratio = this.crowdVoicedCount / this.crowdWindow.length;
    const crowded = ratio >= this.opts.crowdedVoicedRatio;
    if (crowded !== this.crowded) {
      this.crowded = crowded;
      this.callbacks.onEnvironmentChange?.(crowded);
    }
  }

  private openTurn(): void {
    this.state = "speaking";
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.turnMs = 0;
    this.turnPeakRms = 0;
    this.dipMs = 0;
    this.callbacks.onActivityStart();
    this.callbacks.onSpeechState?.(true);
    // Vaciar el pre-roll para no perder el ataque de la primera palabra.
    for (const frame of this.preRoll) {
      this.callbacks.onAudio(frame);
      this.turnMs += this.opts.frameMs;
    }
    this.clearPreRoll();
  }

  private closeTurn(): void {
    this.state = "idle";
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.turnMs = 0;
    this.turnPeakRms = 0;
    this.dipMs = 0;
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
    this.turnMs = 0;
    this.turnPeakRms = 0;
    this.dipMs = 0;
    this.residual = Buffer.alloc(0);
    this.clearStopWordState();
    this.echoBaseline = 0;
    this.bargeCandidateMs = 0;
    this.clearPreRoll();
  }

  private adaptNoiseFloor(rms: number): void {
    const rising = rms > this.noiseFloor;
    const alpha = rising ? this.opts.noiseRiseAlpha : this.opts.noiseFallAlpha;
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
