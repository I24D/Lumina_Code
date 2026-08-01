/**
 * AudioProcessor
 *
 * Single-channel real-time DSP chain that sits between the raw microphone PCM
 * (s16le, mono, 16 kHz) and the VoiceActivityGate. It cleans the signal so the
 * gate and Gemini Live receive clearer speech:
 *
 *   1. DC-blocking high-pass filter  → removes DC offset and low-frequency
 *                                       rumble (fans, desk bumps, mains hum).
 *   2. Spectral noise suppression     → STFT + adaptive spectral gate (Hann
 *                                       window, 50% overlap-add) that attenuates
 *                                       stationary background noise while
 *                                       preserving speech.
 *   3. Automatic gain control (AGC)   → smoothly normalises loudness toward a
 *                                       target RMS with a hard limiter so quiet
 *                                       speakers are audible and loud ones do
 *                                       not clip.
 *
 * No AI model is used — this is deterministic DSP. Everything is unit-testable
 * with synthetic signals (see AudioProcessor.vitest.ts).
 *
 * Latency: the STFT stage introduces one analysis window of algorithmic latency
 * (FFT_SIZE samples ≈ 32 ms at 16 kHz), which is imperceptible for conversation.
 */

export interface AudioProcessorOptions {
  sampleRate: number;
  /** Enable the DC-blocking high-pass stage. */
  highPass: boolean;
  /** Cutoff for the high-pass filter, Hz. */
  highPassHz: number;
  /** Enable spectral noise suppression. */
  noiseSuppression: boolean;
  /** Over-subtraction factor (>1 removes more noise, risks artifacts). */
  noiseOverSubtraction: number;
  /** Minimum spectral gain floor (0..1) to avoid "musical noise". */
  noiseFloorGain: number;
  /** Enable automatic gain control. */
  agc: boolean;
  /** Target RMS for AGC, in s16 units (0..32767). */
  agcTargetRms: number;
  /** Maximum gain AGC may apply. */
  agcMaxGain: number;
  /** Gain available immediately, before the AGC has observed enough speech. */
  agcInitialGain: number;
  /** RMS below which the AGC does not chase the noise floor. */
  agcMinInputRms: number;
  /** Time constant for reducing gain when the input becomes loud. */
  agcAttackMs: number;
  /** Time constant for increasing gain when the input is quiet. */
  agcReleaseMs: number;
}

export const DEFAULT_AUDIO_PROCESSOR_OPTIONS: AudioProcessorOptions = {
  sampleRate: 16000,
  highPass: true,
  highPassHz: 80,
  noiseSuppression: true,
  noiseOverSubtraction: 1.5,
  noiseFloorGain: 0.12,
  agc: true,
  agcTargetRms: 2800,
  agcMaxGain: 8,
  agcInitialGain: 2.5,
  agcMinInputRms: 24,
  agcAttackMs: 45,
  agcReleaseMs: 180,
};

const FFT_SIZE = 512;
const HOP_SIZE = 256; // 50% overlap

const S16_MAX = 32767;
const S16_MIN = -32768;

function clampS16(value: number): number {
  if (value > S16_MAX) {
    return S16_MAX;
  }
  if (value < S16_MIN) {
    return S16_MIN;
  }
  return value;
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT.
 * `re`/`im` length must be a power of two. `inverse` computes the IFFT.
 */
export function fftInPlace(
  re: Float64Array,
  im: Float64Array,
  inverse = false,
): void {
  const n = re.length;
  if (n <= 1) {
    return;
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
        const vIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** First-order DC-blocking high-pass filter: y[n] = x[n] - x[n-1] + R*y[n-1]. */
class DcBlockingHighPass {
  private readonly r: number;
  private prevX = 0;
  private prevY = 0;

  constructor(sampleRate: number, cutoffHz: number) {
    // R positions the pole near the unit circle just below the cutoff.
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  processSample(x: number): number {
    const y = x - this.prevX + this.r * this.prevY;
    this.prevX = x;
    this.prevY = y;
    return y;
  }
}

/**
 * STFT spectral noise suppressor with an adaptively estimated noise magnitude
 * spectrum and per-bin spectral-subtraction gain.
 */
class SpectralNoiseSuppressor {
  private readonly window: Float64Array;
  private readonly noiseMag: Float64Array;
  private noiseInitialized = false;
  private readonly inputRing: Float64Array;
  private ringFill = 0;
  private readonly overlap: Float64Array;

  constructor(
    private readonly overSubtraction: number,
    private readonly floorGain: number,
  ) {
    this.window = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      // Root-Hann window applied on BOTH analysis and synthesis (WOLA): the
      // product is a full Hann, whose 50%-overlap sum is a constant 1.0, giving
      // exact overlap-add reconstruction.
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
      this.window[i] = Math.sqrt(hann);
    }
    this.noiseMag = new Float64Array(FFT_SIZE / 2 + 1);
    this.inputRing = new Float64Array(FFT_SIZE);
    this.overlap = new Float64Array(FFT_SIZE - HOP_SIZE);
  }

  /**
   * Push HOP_SIZE new samples, return HOP_SIZE denoised samples (delayed by one
   * analysis window). Input/output are float sample values (s16 scale).
   */
  processHop(hop: Float64Array): Float64Array {
    // Shift ring left by HOP and append the new hop.
    this.inputRing.copyWithin(0, HOP_SIZE);
    this.inputRing.set(hop, FFT_SIZE - HOP_SIZE);
    this.ringFill = Math.min(FFT_SIZE, this.ringFill + HOP_SIZE);
    if (this.ringFill < FFT_SIZE) {
      // Not enough context yet — emit silence for the priming window.
      return new Float64Array(HOP_SIZE);
    }

    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = this.inputRing[i] * this.window[i];
    }
    fftInPlace(re, im, false);

    const bins = FFT_SIZE / 2 + 1;
    const mag = new Float64Array(bins);
    const phase = new Float64Array(bins);
    let frameEnergy = 0;
    for (let k = 0; k < bins; k += 1) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
      frameEnergy += mag[k];
    }

    // Adaptive noise estimate: update quickly at first, then only during frames
    // that look like noise (energy close to the running noise level).
    if (!this.noiseInitialized) {
      this.noiseMag.set(mag);
      this.noiseInitialized = true;
    } else {
      let noiseEnergy = 0;
      for (let k = 0; k < bins; k += 1) {
        noiseEnergy += this.noiseMag[k];
      }
      const isProbablyNoise = frameEnergy < noiseEnergy * 1.8;
      const alpha = isProbablyNoise ? 0.1 : 0.02;
      for (let k = 0; k < bins; k += 1) {
        this.noiseMag[k] = (1 - alpha) * this.noiseMag[k] + alpha * mag[k];
      }
    }

    // Spectral subtraction with a gain floor.
    for (let k = 0; k < bins; k += 1) {
      const cleanMag = Math.max(
        mag[k] - this.overSubtraction * this.noiseMag[k],
        0,
      );
      const gain = mag[k] > 1e-9 ? cleanMag / mag[k] : 0;
      const g = Math.max(gain, this.floorGain);
      const outMag = mag[k] * g;
      re[k] = outMag * Math.cos(phase[k]);
      im[k] = outMag * Math.sin(phase[k]);
      // Maintain conjugate symmetry for a real inverse transform.
      if (k > 0 && k < FFT_SIZE / 2) {
        re[FFT_SIZE - k] = re[k];
        im[FFT_SIZE - k] = -im[k];
      }
    }

    fftInPlace(re, im, true);

    // Overlap-add: window again (analysis+synthesis Hann) and add the tail.
    const out = new Float64Array(HOP_SIZE);
    const nextOverlap = new Float64Array(FFT_SIZE - HOP_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = re[i] * this.window[i];
      if (i < FFT_SIZE - HOP_SIZE) {
        const summed = sample + this.overlap[i];
        if (i < HOP_SIZE) {
          out[i] = summed;
        } else {
          nextOverlap[i - HOP_SIZE] = summed;
        }
      } else {
        nextOverlap[i - HOP_SIZE] = sample;
      }
    }
    // The COLA normalisation for a Hann window at 50% overlap is 1.0 (the
    // squared-window sum equals 1 across the two overlapping frames).
    this.overlap.set(nextOverlap);
    return out;
  }
}

/** Smooth automatic gain control toward a target RMS with a hard limiter. */
class AutomaticGainControl {
  private gain: number;

  constructor(
    private readonly targetRms: number,
    private readonly maxGain: number,
    initialGain: number,
    private readonly minInputRms: number,
    private readonly attackMs: number,
    private readonly releaseMs: number,
    private readonly sampleRate: number,
  ) {
    this.gain = Math.max(1, Math.min(maxGain, initialGain));
  }

  processInPlace(samples: Float64Array): void {
    if (samples.length === 0) {
      return;
    }

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    if (rms >= this.minInputRms) {
      const desired = Math.min(this.maxGain, this.targetRms / rms);
      // FFmpeg emits variably sized chunks, so derive smoothing from elapsed
      // audio time instead of applying a fixed coefficient per callback.
      const chunkMs = (samples.length / this.sampleRate) * 1000;
      const timeConstant =
        desired < this.gain ? this.attackMs : this.releaseMs;
      const smoothing = 1 - Math.exp(-chunkMs / Math.max(1, timeConstant));
      this.gain = (1 - smoothing) * this.gain + smoothing * desired;
    }
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = clampS16(samples[i] * this.gain);
    }
  }
}

export class AudioProcessor {
  private readonly opts: AudioProcessorOptions;
  private readonly highPass?: DcBlockingHighPass;
  private readonly suppressor?: SpectralNoiseSuppressor;
  private readonly agc?: AutomaticGainControl;
  private pending = new Float64Array(0);

  constructor(options?: Partial<AudioProcessorOptions>) {
    this.opts = { ...DEFAULT_AUDIO_PROCESSOR_OPTIONS, ...(options ?? {}) };
    if (this.opts.highPass) {
      this.highPass = new DcBlockingHighPass(
        this.opts.sampleRate,
        this.opts.highPassHz,
      );
    }
    if (this.opts.noiseSuppression) {
      this.suppressor = new SpectralNoiseSuppressor(
        this.opts.noiseOverSubtraction,
        this.opts.noiseFloorGain,
      );
    }
    if (this.opts.agc) {
      this.agc = new AutomaticGainControl(
        this.opts.agcTargetRms,
        this.opts.agcMaxGain,
        this.opts.agcInitialGain,
        this.opts.agcMinInputRms,
        this.opts.agcAttackMs,
        this.opts.agcReleaseMs,
        this.opts.sampleRate,
      );
    }
  }

  /** True when at least one DSP stage is active. */
  get isActive(): boolean {
    return Boolean(this.highPass || this.suppressor || this.agc);
  }

  /**
   * Process an arbitrary chunk of s16le mono PCM and return processed s16le PCM.
   * When noise suppression is enabled the output is aligned to HOP_SIZE frames,
   * so a few residual samples may be buffered internally between calls.
   */
  process(chunk: Buffer): Buffer {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount === 0) {
      return Buffer.alloc(0);
    }

    // Decode to float and apply the per-sample high-pass first.
    const decoded = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      const s = chunk.readInt16LE(i * 2);
      decoded[i] = this.highPass ? this.highPass.processSample(s) : s;
    }

    let processed: Float64Array;
    if (this.suppressor) {
      // Accumulate and run whole HOP_SIZE frames through the STFT suppressor.
      const merged = new Float64Array(this.pending.length + decoded.length);
      merged.set(this.pending, 0);
      merged.set(decoded, this.pending.length);

      const usableHops = Math.floor(merged.length / HOP_SIZE);
      const producedLength = usableHops * HOP_SIZE;
      processed = new Float64Array(producedLength);
      for (let h = 0; h < usableHops; h += 1) {
        const hop = merged.subarray(h * HOP_SIZE, (h + 1) * HOP_SIZE);
        const outHop = this.suppressor.processHop(hop);
        processed.set(outHop, h * HOP_SIZE);
      }
      this.pending = merged.slice(producedLength);
    } else {
      processed = decoded;
    }

    if (this.agc) {
      this.agc.processInPlace(processed);
    }

    const out = Buffer.alloc(processed.length * 2);
    for (let i = 0; i < processed.length; i += 1) {
      out.writeInt16LE(clampS16(Math.round(processed[i])), i * 2);
    }
    return out;
  }
}
