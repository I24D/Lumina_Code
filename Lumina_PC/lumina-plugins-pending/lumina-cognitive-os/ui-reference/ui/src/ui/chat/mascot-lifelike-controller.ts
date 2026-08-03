// Mascot Lifelike Controller — Phase 5
// ────────────────────────────────────────────────────────────────
// Drives the Lumina mascot SVG via CSS custom properties on a
// requestAnimationFrame loop. The mascot SVG itself stays exactly
// as it was; this controller publishes values that the existing
// CSS reads via `var(--lumina-mouth-open)` etc.
//
// What it solves (user feedback):
//   "actualmente no mueve la boca... que se mueva a la derecha,
//    izquierda… que tenga vida no solo que esté fijo"
//
// What it does:
//   1. Real lip sync — connects a WebAudio AnalyserNode to the
//      assistant's audio output and converts amplitude to a 0..1
//      `--lumina-mouth-open` value the CSS reads. If no audio is
//      attached, falls back to a synthetic envelope while the
//      overlay state is "speaking".
//   2. Head sway — slow horizontal drift + small tilt, refreshed
//      via two layered sinusoids with random phase shifts so the
//      motion never looks looped.
//   3. Microsaccades — eyes dart to a new target every 1.5–4 s
//      and ease to it; superimposed jitter at ~6 Hz.
//   4. Antenna sway — always active (was only thinking before).
//   5. Reduced motion — respects the OS preference.
//
// Design rules:
//   - No new DOM. Only writes CSS variables on the mascot root.
//   - Works without audio. If audio attaches later, the controller
//     swaps from the synthetic envelope to the real analyser
//     without restarting the rAF loop.
//   - Idle CPU is bounded: rAF runs only while the controller is
//     `started`. When stopped, the loop exits and CSS vars are
//     reset to defaults.

const HEAD_SWAY_PERIOD_MS_A = 5_200; // primary slow drift
const HEAD_SWAY_PERIOD_MS_B = 11_700; // secondary drift to break the loop
const HEAD_SWAY_MAX_X = 14; // px
const HEAD_SWAY_MAX_TILT_DEG = 3.2;

const ANTENNA_PERIOD_MS = 3_400;
const ANTENNA_MAX_DEG = 6;

const SACCADE_INTERVAL_MIN_MS = 1_500;
const SACCADE_INTERVAL_MAX_MS = 4_000;
const SACCADE_MAX_X = 3.5;
const SACCADE_MAX_Y = 1.8;

const MOUTH_SMOOTH_ATTACK = 0.45; // exponential moving average toward target
const MOUTH_SMOOTH_RELEASE = 0.18;

const SYNTHETIC_SPEECH_PERIOD_MS = 360;

export type MascotControllerState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  // Nivel 7 — Avatar Cognitivo expanded expressions.
  | "searching"   // "buscando" — eyes dart faster, antennae lean forward
  | "executing"   // "ejecutando" — small arm bounce, antennae steady
  | "learning"    // "aprendiendo" — slow happy bob, iris pulse
  | "error"       // "error" — eyes narrow, antenna droop
  | "alert";      // "alerta" — halo brightens, body shakes once

export type MascotLifelikeControllerOptions = {
  /** Root element of the mascot (the `<svg class="lumina-mascot">`). */
  readonly target: HTMLElement;
};

export class MascotLifelikeController {
  private readonly target: HTMLElement;
  private rafHandle: number | null = null;
  private startMs = 0;
  private state: MascotControllerState = "idle";

  // Audio
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private ownsAudioContext = false;

  // Smoothing
  private mouthLevel = 0;
  private saccadeTargetX = 0;
  private saccadeTargetY = 0;
  private saccadeCurrentX = 0;
  private saccadeCurrentY = 0;
  private nextSaccadeAtMs = 0;

  // Random per-instance phases so two overlays never animate in lockstep.
  private readonly phaseA = Math.random() * Math.PI * 2;
  private readonly phaseB = Math.random() * Math.PI * 2;
  private readonly phaseAntenna = Math.random() * Math.PI * 2;

  // Reduced motion latch — read once at start to avoid layout thrash.
  private reducedMotion = false;

  constructor(opts: MascotLifelikeControllerOptions) {
    this.target = opts.target;
  }

  start(): void {
    if (this.rafHandle !== null) return;
    this.reducedMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.startMs = performance.now();
    this.nextSaccadeAtMs = this.startMs + SACCADE_INTERVAL_MIN_MS;
    this.loop = this.loop.bind(this);
    this.rafHandle = requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.detachAudio();
    this.resetVars();
  }

  setState(state: MascotControllerState): void {
    if (this.state === state) return;
    this.state = state;
    // Publish for CSS to react (per-state colors, halo amp, body shake).
    try {
      this.target.setAttribute("data-mascot-state", state);
    } catch {
      /* defensive — target may have been detached */
    }
  }

  /**
   * Attach to a MediaStream (e.g. the assistant's WebRTC audio track) or to
   * a plain `<audio>` element. The controller takes care of the AudioContext;
   * we never reuse the caller's nodes so detaching is safe.
   */
  attachAudio(source: MediaStream | HTMLAudioElement): void {
    this.detachAudio();
    try {
      const ctx = new (window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      this.audioContext = ctx;
      this.ownsAudioContext = true;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.45;
      if (source instanceof MediaStream) {
        ctx.createMediaStreamSource(source).connect(analyser);
      } else {
        ctx.createMediaElementSource(source).connect(analyser);
        // Re-route to destination so the user can still hear the audio.
        analyser.connect(ctx.destination);
      }
      this.analyser = analyser;
      this.analyserBuffer = new Float32Array(analyser.fftSize);
    } catch {
      // Audio attach can fail (user gesture not given, etc.). Synthetic
      // envelope takes over.
      this.detachAudio();
    }
  }

  detachAudio(): void {
    this.analyser = null;
    this.analyserBuffer = null;
    if (this.audioContext !== null && this.ownsAudioContext) {
      void this.audioContext.close().catch(() => undefined);
    }
    this.audioContext = null;
    this.ownsAudioContext = false;
  }

  /**
   * Use the caller's existing AudioContext (e.g. the one the realtime-talk
   * PCM queue already created) and return an AnalyserNode the caller should
   * connect its source(s) to. This is the preferred path for Gemini Live
   * audio, which arrives as PCM frames decoded into a shared AudioContext.
   *
   * The caller OWNS the AudioContext — we never close it.
   */
  attachAnalyser(audioContext: AudioContext): AnalyserNode {
    this.detachAudio();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;
    this.analyser = analyser;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    this.audioContext = audioContext;
    this.ownsAudioContext = false;
    return analyser;
  }

  // ─── internals ────────────────────────────────────────────────

  private loop(): void {
    if (this.reducedMotion) {
      // Don't churn rAF when the user wants stillness. Still listen so
      // start()/stop() work consistently.
      this.rafHandle = requestAnimationFrame(this.loop);
      return;
    }
    const now = performance.now();
    const elapsed = now - this.startMs;

    // ── Head sway ── two sinusoids with random phases.
    const swayA = Math.sin((elapsed / HEAD_SWAY_PERIOD_MS_A) * Math.PI * 2 + this.phaseA);
    const swayB = Math.sin((elapsed / HEAD_SWAY_PERIOD_MS_B) * Math.PI * 2 + this.phaseB);
    const sway = (swayA * 0.7 + swayB * 0.3);
    const headX = sway * HEAD_SWAY_MAX_X;
    const headTilt = sway * HEAD_SWAY_MAX_TILT_DEG;

    // ── Antenna sway ── always-on slow oscillation; speaking/searching/alert amplify.
    let antennaBoost = 1.0;
    switch (this.state) {
      case "speaking": antennaBoost = 1.6; break;
      case "thinking":
      case "searching": antennaBoost = 1.4; break;
      case "executing": antennaBoost = 1.1; break;
      case "alert": antennaBoost = 2.2; break;
      case "error": antennaBoost = 0.3; break;
      case "learning": antennaBoost = 1.25; break;
    }
    const antenna = Math.sin((elapsed / ANTENNA_PERIOD_MS) * Math.PI * 2 + this.phaseAntenna)
      * ANTENNA_MAX_DEG * antennaBoost;

    // ── Microsaccades ── pick a new target on schedule, ease toward it.
    // Faster cadence while searching; almost frozen on error.
    if (now >= this.nextSaccadeAtMs) {
      this.saccadeTargetX = (Math.random() * 2 - 1) * SACCADE_MAX_X;
      this.saccadeTargetY = (Math.random() * 2 - 1) * SACCADE_MAX_Y;
      const span = SACCADE_INTERVAL_MAX_MS - SACCADE_INTERVAL_MIN_MS;
      const interval =
        this.state === "searching"
          ? SACCADE_INTERVAL_MIN_MS * 0.4
          : this.state === "error"
            ? SACCADE_INTERVAL_MAX_MS * 2
            : SACCADE_INTERVAL_MIN_MS + Math.random() * span;
      this.nextSaccadeAtMs = now + interval;
    }
    this.saccadeCurrentX += (this.saccadeTargetX - this.saccadeCurrentX) * 0.12;
    this.saccadeCurrentY += (this.saccadeTargetY - this.saccadeCurrentY) * 0.12;

    // ── Mouth open level ── prefer audio amplitude when available.
    let mouthTarget = 0;
    if (this.state === "speaking") {
      mouthTarget = this.readAudioAmplitude() ?? this.syntheticEnvelope(elapsed);
    }
    const mouthGain = mouthTarget > this.mouthLevel ? MOUTH_SMOOTH_ATTACK : MOUTH_SMOOTH_RELEASE;
    this.mouthLevel += (mouthTarget - this.mouthLevel) * mouthGain;
    if (this.mouthLevel < 0.002) this.mouthLevel = 0;

    // ── Per-state expression vars (Nivel 7) ──────────────────────
    // eyeNarrow: scale-y of the eye whites (1=open, 0.4=narrow on error)
    // bodyShake: px offset that the CSS animation can pick up on alert
    // haloAmp: 0..1.5 modulates the halo blob radius/opacity
    let eyeNarrow = 1.0;
    let bodyShake = 0;
    let haloAmp = 0;
    let irisPulse = 0;
    switch (this.state) {
      case "listening": haloAmp = 1.0; break;
      case "speaking": haloAmp = 0.35; break;
      case "thinking":
      case "searching": haloAmp = 0.5; irisPulse = 0.3; break;
      case "executing": haloAmp = 0.7; break;
      case "learning": haloAmp = 0.6; irisPulse = 0.6; break;
      case "error": eyeNarrow = 0.4; haloAmp = 0.0; break;
      case "alert":
        eyeNarrow = 1.2;
        haloAmp = 1.4;
        bodyShake = Math.sin(elapsed * 0.02) * 1.6;
        break;
    }

    // Publish.
    const s = this.target.style;
    s.setProperty("--lumina-head-x", `${(headX + bodyShake).toFixed(2)}px`);
    s.setProperty("--lumina-head-tilt", `${headTilt.toFixed(2)}deg`);
    s.setProperty("--lumina-antenna-deg", `${antenna.toFixed(2)}deg`);
    s.setProperty("--lumina-eye-x", `${this.saccadeCurrentX.toFixed(2)}px`);
    s.setProperty("--lumina-eye-y", `${this.saccadeCurrentY.toFixed(2)}px`);
    s.setProperty("--lumina-mouth-open", this.mouthLevel.toFixed(3));
    s.setProperty("--lumina-eye-narrow", eyeNarrow.toFixed(3));
    s.setProperty("--lumina-halo-amp", haloAmp.toFixed(3));
    s.setProperty("--lumina-iris-pulse", irisPulse.toFixed(3));
    s.setProperty("--lumina-body-shake", `${bodyShake.toFixed(2)}px`);

    this.rafHandle = requestAnimationFrame(this.loop);
  }

  /** Returns 0..1 or null if no analyser is attached. */
  private readAudioAmplitude(): number | null {
    if (this.analyser === null || this.analyserBuffer === null) return null;
    this.analyser.getFloatTimeDomainData(this.analyserBuffer);
    let sum = 0;
    for (let i = 0; i < this.analyserBuffer.length; i += 1) {
      const v = this.analyserBuffer[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.analyserBuffer.length);
    // Map RMS to 0..1 — speech RMS rarely exceeds ~0.35.
    return Math.min(1, rms / 0.32);
  }

  /** Believable open/close pattern when no audio is available. Drives a
   *  syllabic rhythm via a sin² envelope so the mouth never sticks open. */
  private syntheticEnvelope(elapsed: number): number {
    const t = (elapsed % SYNTHETIC_SPEECH_PERIOD_MS) / SYNTHETIC_SPEECH_PERIOD_MS;
    const sin = Math.sin(t * Math.PI);
    return Math.max(0, sin * sin) * 0.78;
  }

  private resetVars(): void {
    const s = this.target.style;
    s.removeProperty("--lumina-head-x");
    s.removeProperty("--lumina-head-tilt");
    s.removeProperty("--lumina-antenna-deg");
    s.removeProperty("--lumina-eye-x");
    s.removeProperty("--lumina-eye-y");
    s.removeProperty("--lumina-mouth-open");
    s.removeProperty("--lumina-eye-narrow");
    s.removeProperty("--lumina-halo-amp");
    s.removeProperty("--lumina-iris-pulse");
    s.removeProperty("--lumina-body-shake");
    try {
      this.target.removeAttribute("data-mascot-state");
    } catch {
      /* ignore */
    }
    this.mouthLevel = 0;
  }
}
