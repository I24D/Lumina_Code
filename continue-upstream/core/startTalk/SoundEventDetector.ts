/**
 * SoundEventDetector
 *
 * Model-free acoustic-event classifier for the microphone stream. It analyses
 * fixed windows of s16le mono PCM and assigns a coarse category using classic
 * DSP features (RMS energy, zero-crossing rate, spectral flatness, spectral
 * centroid, crest factor):
 *
 *   - "silence"    : below the energy floor.
 *   - "tonal"      : narrowband / peaky spectrum (alarms, beeps, whistles).
 *   - "broadband"  : noise-like, flat spectrum at high energy (hiss, crowd).
 *   - "impulsive"  : short high-crest transient (claps, knocks, door slams).
 *   - "speech"     : everything else with speech-like structure.
 *
 * No AI model is involved — everything is deterministic and unit-testable.
 * Emits a debounced result so callers are not flooded with per-window events.
 */
import { fftInPlace } from "./fft.js";
import type { StartTalkSoundCategory } from "./types.js";

const WINDOW_SIZE = 512;

export interface SoundEvent {
  category: StartTalkSoundCategory;
  confidence: number;
}

export interface SoundEventDetectorOptions {
  sampleRate: number;
  /** RMS below this (s16 scale) is treated as silence. */
  silenceRms: number;
  /** Spectral flatness below this is considered tonal. */
  tonalFlatness: number;
  /** Spectral flatness above this is considered broadband noise. */
  broadbandFlatness: number;
  /** Crest factor (peak/RMS) above this marks an impulsive transient. */
  impulsiveCrest: number;
  /** Number of consecutive equal classifications before emitting. */
  debounceWindows: number;
}

export const DEFAULT_SOUND_EVENT_OPTIONS: SoundEventDetectorOptions = {
  sampleRate: 16000,
  silenceRms: 120,
  tonalFlatness: 0.15,
  broadbandFlatness: 0.5,
  impulsiveCrest: 8,
  debounceWindows: 2,
};

export class SoundEventDetector {
  private readonly opts: SoundEventDetectorOptions;
  private readonly window: Float64Array;
  private residual: Float64Array = new Float64Array(0);
  private lastCategory: StartTalkSoundCategory | null = null;
  private pendingCategory: StartTalkSoundCategory | null = null;
  private pendingCount = 0;

  constructor(options?: Partial<SoundEventDetectorOptions>) {
    this.opts = { ...DEFAULT_SOUND_EVENT_OPTIONS, ...(options ?? {}) };
    this.window = new Float64Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW_SIZE);
    }
  }

  /** Classifies a single window of samples (s16 scale). */
  classifyWindow(samples: Float64Array): SoundEvent {
    let sumSquares = 0;
    let peak = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      sumSquares += s * s;
      const abs = Math.abs(s);
      if (abs > peak) {
        peak = abs;
      }
      if (i > 0 && Math.sign(samples[i]) !== Math.sign(samples[i - 1])) {
        zeroCrossings += 1;
      }
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
    if (rms < this.opts.silenceRms) {
      return { category: "silence", confidence: 1 };
    }

    const crest = rms > 1e-6 ? peak / rms : 0;
    if (crest > this.opts.impulsiveCrest && peak > this.opts.silenceRms * 8) {
      return {
        category: "impulsive",
        confidence: Math.min(1, crest / (this.opts.impulsiveCrest * 2)),
      };
    }

    // Spectral features via FFT.
    const re = new Float64Array(WINDOW_SIZE);
    const im = new Float64Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      re[i] = (samples[i] ?? 0) * this.window[i];
    }
    fftInPlace(re, im, false);
    const bins = WINDOW_SIZE / 2 + 1;
    let logSum = 0;
    let arithSum = 0;
    let weightedFreq = 0;
    for (let k = 0; k < bins; k += 1) {
      const mag = Math.hypot(re[k], im[k]) + 1e-9;
      logSum += Math.log(mag);
      arithSum += mag;
      weightedFreq += k * mag;
    }
    const geoMean = Math.exp(logSum / bins);
    const arithMean = arithSum / bins;
    const flatness = arithMean > 1e-9 ? geoMean / arithMean : 0;
    const centroidBin = arithSum > 1e-9 ? weightedFreq / arithSum : 0;
    const zcr = zeroCrossings / samples.length;

    if (flatness < this.opts.tonalFlatness && zcr < 0.25) {
      return {
        category: "tonal",
        confidence: Math.min(1, this.opts.tonalFlatness / (flatness + 1e-6)),
      };
    }
    if (flatness > this.opts.broadbandFlatness) {
      return {
        category: "broadband",
        confidence: Math.min(1, flatness / this.opts.broadbandFlatness - 1 + 0.6),
      };
    }
    // Speech: mid flatness, mid centroid, non-trivial zero-crossing structure.
    const speechConfidence = 0.5 + Math.min(0.5, Math.abs(centroidBin) / bins);
    return { category: "speech", confidence: speechConfidence };
  }

  /**
   * Feeds arbitrary PCM. Returns a SoundEvent only when a NEW (debounced)
   * category is confirmed; otherwise null.
   */
  process(chunk: Buffer): SoundEvent | null {
    const incoming = new Float64Array(Math.floor(chunk.length / 2));
    for (let i = 0; i < incoming.length; i += 1) {
      incoming[i] = chunk.readInt16LE(i * 2);
    }

    const merged = new Float64Array(this.residual.length + incoming.length);
    merged.set(this.residual, 0);
    merged.set(incoming, this.residual.length);

    const windows = Math.floor(merged.length / WINDOW_SIZE);
    let emitted: SoundEvent | null = null;
    for (let w = 0; w < windows; w += 1) {
      const window = merged.subarray(w * WINDOW_SIZE, (w + 1) * WINDOW_SIZE);
      const result = this.classifyWindow(window);
      emitted = this.debounce(result) ?? emitted;
    }
    this.residual = merged.slice(windows * WINDOW_SIZE);
    return emitted;
  }

  private debounce(result: SoundEvent): SoundEvent | null {
    if (result.category === this.pendingCategory) {
      this.pendingCount += 1;
    } else {
      this.pendingCategory = result.category;
      this.pendingCount = 1;
    }
    if (
      this.pendingCount >= this.opts.debounceWindows &&
      result.category !== this.lastCategory
    ) {
      this.lastCategory = result.category;
      return result;
    }
    return null;
  }
}
