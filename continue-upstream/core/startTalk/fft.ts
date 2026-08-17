/**
 * fft.ts — Transformada rápida de Fourier, in-place.
 *
 * Vivía dentro de `AudioProcessor`, que se retiró al mover la limpieza del
 * micrófono al pipeline WebRTC de Chromium (AEC real). `SoundEventDetector`
 * sigue necesitando el análisis espectral, así que la FFT queda aquí, sin
 * arrastrar consigo el resto del DSP que ya no se usa.
 */

/**
 * FFT iterativa radix-2 de Cooley–Tukey, in-place.
 * `re`/`im` deben tener longitud potencia de dos. `inverse` calcula la IFFT.
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

  // Permutación por inversión de bits.
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
