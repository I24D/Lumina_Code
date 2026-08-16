/**
 * TurnMetrics.ts — Métricas por turno de conversación.
 *
 * Por qué existe: hasta ahora cada mejora de Start Talk se evaluaba a oído, y
 * eso ya falló de forma medible. Dos ejemplos reales de este proyecto:
 *
 *  - `mpdecimate` llevaba tiempo sin decimar nada porque le faltaba
 *    `-fps_mode vfr`. Nada fallaba visiblemente.
 *  - Se daba por hecho que el servidor entregaba el audio en tiempo real. Mide
 *    hasta 3,6x más rápido, y de ahí salían los cortes en lecturas largas.
 *
 * Ninguno de los dos se habría detectado escuchando. Este módulo registra los
 * números que importan por turno, para que la siguiente decisión (Silero, AEC,
 * cambio de modelo) se tome mirando datos.
 *
 * Es DSP-free y sin dependencias: solo contabilidad con un reloj inyectable.
 */

/** Un turno cerrado, con sus tiempos ya calculados. */
export interface StartTalkTurnMetrics {
  turnId: number;
  /** Cuánto habló el usuario, de activityStart a activityEnd. */
  userSpeechMs: number;
  /**
   * Latencia de respuesta: del fin del turno del usuario al primer audio de
   * Lumina. Es EL número de experiencia de usuario en una conversación hablada.
   */
  responseLatencyMs?: number;
  /** Segundos de voz que generó Lumina en este turno. */
  assistantAudioSeconds: number;
  /** Fragmentos de audio recibidos. Delata modelos que trocean en exceso. */
  assistantChunks: number;
  /**
   * Velocidad de entrega respecto al tiempo real. >1 significa que el servidor
   * manda el audio más rápido de lo que se puede reproducir, así que se acumula
   * cola en el cliente. Medido: ~2,7-3,0x en 3.1 y ~3,6x en 2.5.
   */
  deliveryRate?: number;
  /** El usuario la cortó (o algo disparó una interrupción). */
  interrupted: boolean;
  /**
   * Turno abierto y cerrado sin que llegara transcripción del usuario: el gate
   * se disparó con algo que no era voz. Es la métrica de falsos positivos.
   */
  falseStart: boolean;
  /** Resolvió el turno con `stay_silent` en vez de hablar. */
  stayedSilent: boolean;
  /** Había varias voces solapadas cuando ocurrió. */
  crowded: boolean;
}

/** Acumulado de la sesión, para un vistazo rápido. */
export interface StartTalkSessionMetrics {
  turns: number;
  falseStarts: number;
  interruptions: number;
  silentTurns: number;
  reconnects: number;
  captureRestarts: number;
  videoRestarts: number;
  searches: number;
  /** Mediana de latencia de respuesta; la media la distorsiona un solo pico. */
  medianResponseLatencyMs?: number;
  p90ResponseLatencyMs?: number;
  /** Velocidad media de entrega observada en la sesión. */
  meanDeliveryRate?: number;
}

/**
 * Percentil por rango más cercano (`ceil(p·N) - 1`), la definición habitual en
 * monitorización. No interpola: devuelve siempre un valor observado de verdad,
 * que para latencias es lo que se quiere. `p` en [0, 1].
 */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index];
}

/** Cuántas latencias se conservan para los percentiles (acotado en memoria). */
const MAX_TRACKED_LATENCIES = 200;

export class TurnMetricsTracker {
  private readonly now: () => number;

  private turnId = 0;
  private turnStartedAt?: number;
  private turnEndedAt?: number;
  private firstAudioAt?: number;
  private lastAudioAt?: number;
  private sawUserTranscript = false;
  private interrupted = false;
  private stayedSilent = false;
  private crowded = false;
  private audioBytes = 0;
  private audioSampleRate = 24000;
  private chunks = 0;
  /** Un turno abierto por el gate pero aún no cerrado. */
  private open = false;

  private readonly latencies: number[] = [];
  private readonly deliveryRates: number[] = [];
  private totals = {
    turns: 0,
    falseStarts: 0,
    interruptions: 0,
    silentTurns: 0,
    reconnects: 0,
    captureRestarts: 0,
    videoRestarts: 0,
    searches: 0,
  };

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** El gate cedió el turno al usuario. */
  onActivityStart(): void {
    this.resetTurn();
    this.open = true;
    this.turnStartedAt = this.now();
  }

  /** Llegó transcripción del usuario: hubo voz de verdad, no un falso positivo. */
  onUserTranscript(text: string): void {
    if (String(text ?? "").trim()) {
      this.sawUserTranscript = true;
    }
  }

  /** El gate cerró el turno; a partir de aquí se mide la latencia de respuesta. */
  onActivityEnd(): void {
    if (!this.open) {
      return;
    }
    this.turnEndedAt = this.now();
  }

  onCrowded(crowded: boolean): void {
    this.crowded = crowded;
  }

  /** Fragmento de audio de Lumina. */
  onAssistantAudio(byteLength: number, sampleRate: number): void {
    const at = this.now();
    if (this.firstAudioAt === undefined) {
      this.firstAudioAt = at;
    }
    this.lastAudioAt = at;
    this.audioBytes += byteLength;
    this.audioSampleRate = sampleRate || this.audioSampleRate;
    this.chunks += 1;
  }

  onInterrupted(): void {
    this.interrupted = true;
  }

  onStayedSilent(): void {
    this.stayedSilent = true;
  }

  onSearch(): void {
    this.totals.searches += 1;
  }

  onReconnect(): void {
    this.totals.reconnects += 1;
  }

  onCaptureRestart(): void {
    this.totals.captureRestarts += 1;
  }

  onVideoRestart(): void {
    this.totals.videoRestarts += 1;
  }

  /**
   * El servidor cerró el turno. Devuelve las métricas del turno, o `undefined`
   * si no había ninguno en curso (turnComplete suelto tras una reconexión).
   */
  onTurnComplete(): StartTalkTurnMetrics | undefined {
    if (!this.open && this.chunks === 0) {
      return undefined;
    }

    const assistantAudioSeconds =
      this.audioBytes / 2 / (this.audioSampleRate || 24000);

    let responseLatencyMs: number | undefined;
    if (this.turnEndedAt !== undefined && this.firstAudioAt !== undefined) {
      responseLatencyMs = Math.max(0, this.firstAudioAt - this.turnEndedAt);
    }

    let deliveryRate: number | undefined;
    if (
      this.firstAudioAt !== undefined &&
      this.lastAudioAt !== undefined &&
      this.lastAudioAt > this.firstAudioAt &&
      assistantAudioSeconds > 0
    ) {
      const wallSeconds = (this.lastAudioAt - this.firstAudioAt) / 1000;
      deliveryRate = assistantAudioSeconds / wallSeconds;
    }

    // Un turno con voz del usuario pero sin transcripción es ruido que abrió el
    // gate. Si respondió con stay_silent no cuenta: ahí sí hubo voz, decidió
    // que no era para ella.
    const falseStart =
      this.open && !this.sawUserTranscript && !this.stayedSilent;

    const metrics: StartTalkTurnMetrics = {
      turnId: ++this.turnId,
      userSpeechMs:
        this.turnStartedAt !== undefined && this.turnEndedAt !== undefined
          ? Math.max(0, this.turnEndedAt - this.turnStartedAt)
          : 0,
      ...(responseLatencyMs !== undefined ? { responseLatencyMs } : {}),
      assistantAudioSeconds: Number(assistantAudioSeconds.toFixed(2)),
      assistantChunks: this.chunks,
      ...(deliveryRate !== undefined
        ? { deliveryRate: Number(deliveryRate.toFixed(2)) }
        : {}),
      interrupted: this.interrupted,
      falseStart,
      stayedSilent: this.stayedSilent,
      crowded: this.crowded,
    };

    this.totals.turns += 1;
    if (falseStart) {
      this.totals.falseStarts += 1;
    }
    if (this.interrupted) {
      this.totals.interruptions += 1;
    }
    if (this.stayedSilent) {
      this.totals.silentTurns += 1;
    }
    if (responseLatencyMs !== undefined) {
      this.latencies.push(responseLatencyMs);
      if (this.latencies.length > MAX_TRACKED_LATENCIES) {
        this.latencies.shift();
      }
    }
    if (deliveryRate !== undefined) {
      this.deliveryRates.push(deliveryRate);
      if (this.deliveryRates.length > MAX_TRACKED_LATENCIES) {
        this.deliveryRates.shift();
      }
    }

    this.resetTurn();
    return metrics;
  }

  sessionMetrics(): StartTalkSessionMetrics {
    const meanDeliveryRate =
      this.deliveryRates.length > 0
        ? Number(
            (
              this.deliveryRates.reduce((a, b) => a + b, 0) /
              this.deliveryRates.length
            ).toFixed(2),
          )
        : undefined;

    return {
      ...this.totals,
      ...(percentile(this.latencies, 0.5) !== undefined
        ? { medianResponseLatencyMs: percentile(this.latencies, 0.5) }
        : {}),
      ...(percentile(this.latencies, 0.9) !== undefined
        ? { p90ResponseLatencyMs: percentile(this.latencies, 0.9) }
        : {}),
      ...(meanDeliveryRate !== undefined ? { meanDeliveryRate } : {}),
    };
  }

  private resetTurn(): void {
    this.open = false;
    this.turnStartedAt = undefined;
    this.turnEndedAt = undefined;
    this.firstAudioAt = undefined;
    this.lastAudioAt = undefined;
    this.sawUserTranscript = false;
    this.interrupted = false;
    this.stayedSilent = false;
    this.audioBytes = 0;
    this.chunks = 0;
  }
}
