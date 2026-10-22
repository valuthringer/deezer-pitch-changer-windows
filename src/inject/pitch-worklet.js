// AudioWorkletProcessor: stereo pitch shifter (phase vocoder, identity phase locking).
// Changes pitch without changing duration. Based on Laroche & Dolson (1999):
// spectral peaks are moved to their new frequency and the bins around each peak
// keep their phase relationship, which avoids most of the classic "phasiness".
// Both channels share the same phase rotation so the stereo image stays intact.

const FFT_SIZE = 4096;
const OVERSAMPLING = 4;
const HOP = FFT_SIZE / OVERSAMPLING;
const HALF = FFT_SIZE / 2;
const LATENCY = FFT_SIZE - HOP; // FIFO offset; the processed signal comes out FFT_SIZE samples late
const TWO_PI = Math.PI * 2;
const CROSSFADE_STEP = 1 / HOP;

function princarg(phase) {
  return phase - TWO_PI * Math.round(phase / TWO_PI);
}

class FFT {
  constructor(size) {
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((TWO_PI * i) / size);
      this.sin[i] = Math.sin((TWO_PI * i) / size);
    }
  }

  // In-place complex FFT. inverse=true computes the unscaled inverse transform.
  transform(re, im, inverse) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 1;
    this.mix = 0; // 0 = dry (bypass), 1 = shifted signal
    this.fft = new FFT(FFT_SIZE);

    this.window = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FFT_SIZE);
    let sumSquares = 0;
    for (let i = 0; i < FFT_SIZE; i += HOP) sumSquares += this.window[i] * this.window[i];
    // Normalisation for analysis window * synthesis window overlap-add + unscaled IFFT.
    this.outputScale = 1 / (sumSquares * FFT_SIZE);

    this.inL = new Float64Array(FFT_SIZE);
    this.inR = new Float64Array(FFT_SIZE);
    this.outL = new Float64Array(HOP);
    this.outR = new Float64Array(HOP);
    this.accL = new Float64Array(FFT_SIZE + HOP);
    this.accR = new Float64Array(FFT_SIZE + HOP);
    this.rover = LATENCY;
    this.dryL = new Float32Array(FFT_SIZE);
    this.dryR = new Float32Array(FFT_SIZE);
    this.dryPos = 0;

    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.specL = { re: new Float64Array(HALF + 1), im: new Float64Array(HALF + 1) };
    this.specR = { re: new Float64Array(HALF + 1), im: new Float64Array(HALF + 1) };
    this.synL = { re: new Float64Array(HALF + 1), im: new Float64Array(HALF + 1) };
    this.synR = { re: new Float64Array(HALF + 1), im: new Float64Array(HALF + 1) };
    this.mag = new Float64Array(HALF + 1);
    this.phase = new Float64Array(HALF + 1);
    this.lastPhase = new Float64Array(HALF + 1);
    // Previous synthesis spectrum (sum of channels); its phase is read only at peak bins.
    this.prevSynRe = new Float64Array(HALF + 1);
    this.prevSynIm = new Float64Array(HALF + 1);
    this.trueBin = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF);

    this.port.onmessage = (event) => {
      const ratio = Number(event.data && event.data.ratio);
      if (Number.isFinite(ratio) && ratio > 0) this.ratio = Math.min(4, Math.max(0.25, ratio));
    };
  }

  processFrame() {
    const { re, im, window: win } = this;
    const N = FFT_SIZE;

    // Both channels in one complex FFT: re = left, im = right.
    for (let i = 0; i < N; i++) {
      re[i] = this.inL[i] * win[i];
      im[i] = this.inR[i] * win[i];
    }
    this.fft.transform(re, im, false);

    const L = this.specL;
    const R = this.specR;
    for (let k = 0; k <= HALF; k++) {
      const nk = (N - k) & (N - 1);
      L.re[k] = 0.5 * (re[k] + re[nk]);
      L.im[k] = 0.5 * (im[k] - im[nk]);
      R.re[k] = 0.5 * (im[k] + im[nk]);
      R.im[k] = -0.5 * (re[k] - re[nk]);
    }

    // Analysis on the sum of both channels (reference for peaks and phases).
    const expected = (TWO_PI * HOP) / N;
    let maxMag = 0;
    for (let k = 0; k <= HALF; k++) {
      let sr = L.re[k] + R.re[k];
      let si = L.im[k] + R.im[k];
      const magL = Math.sqrt(L.re[k] * L.re[k] + L.im[k] * L.im[k]);
      const magR = Math.sqrt(R.re[k] * R.re[k] + R.im[k] * R.im[k]);
      const m = magL + magR;
      if (Math.sqrt(sr * sr + si * si) < 1e-3 * m) {
        // Channels cancel out (phase-inverted content): fall back to the left channel.
        sr = L.re[k];
        si = L.im[k];
      }
      const ph = Math.atan2(si, sr);
      this.mag[k] = m;
      this.phase[k] = ph;
      const delta = princarg(ph - this.lastPhase[k] - k * expected);
      this.lastPhase[k] = ph;
      this.trueBin[k] = k + (delta * N) / (TWO_PI * HOP);
      if (m > maxMag) maxMag = m;
    }

    const synL = this.synL;
    const synR = this.synR;
    synL.re.fill(0); synL.im.fill(0);
    synR.re.fill(0); synR.im.fill(0);

    // Peak picking.
    const mag = this.mag;
    const threshold = maxMag * 1e-6 + 1e-12;
    let peakCount = 0;
    for (let k = 2; k < HALF - 1; k++) {
      const m = mag[k];
      if (m > threshold && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) {
        this.peaks[peakCount++] = k;
      }
    }

    const ratio = this.ratio;
    let regionStart = 0;
    for (let p = 0; p < peakCount; p++) {
      const k0 = this.peaks[p];
      // Region of influence ends at the lowest bin between this peak and the next one.
      let regionEnd = HALF;
      if (p + 1 < peakCount) {
        const next = this.peaks[p + 1];
        regionEnd = k0;
        for (let k = k0 + 1; k < next; k++) if (mag[k] < mag[regionEnd]) regionEnd = k;
      }

      // Integer bin shift closest to the real frequency offset; the fractional part is
      // carried by the phase advance.
      const targetFreq = this.trueBin[k0] * ratio;
      const shift = Math.round(targetFreq - this.trueBin[k0]);
      const k1 = k0 + shift;
      if (k1 >= 1 && k1 < HALF) {
        const prevPhase = Math.atan2(this.prevSynIm[k1], this.prevSynRe[k1]);
        const synPhase = prevPhase + (TWO_PI * targetFreq * HOP) / N;
        const rotation = synPhase - this.phase[k0];
        const cr = Math.cos(rotation);
        const ci = Math.sin(rotation);
        for (let k = regionStart; k <= regionEnd; k++) {
          const t = k + shift;
          if (t < 0 || t > HALF) continue;
          synL.re[t] += L.re[k] * cr - L.im[k] * ci;
          synL.im[t] += L.re[k] * ci + L.im[k] * cr;
          synR.re[t] += R.re[k] * cr - R.im[k] * ci;
          synR.im[t] += R.re[k] * ci + R.im[k] * cr;
        }
      }
      regionStart = regionEnd + 1;
    }

    for (let k = 0; k <= HALF; k++) {
      this.prevSynRe[k] = synL.re[k] + synR.re[k];
      this.prevSynIm[k] = synL.im[k] + synR.im[k];
    }

    // Rebuild the full spectrum Z = L + iR (Hermitian halves) and invert once for both channels.
    for (let k = 0; k <= HALF; k++) {
      re[k] = synL.re[k] - synR.im[k];
      im[k] = synL.im[k] + synR.re[k];
    }
    for (let k = HALF + 1; k < N; k++) {
      const m = N - k;
      re[k] = synL.re[m] + synR.im[m];
      im[k] = -synL.im[m] + synR.re[m];
    }
    this.fft.transform(re, im, true);

    const scale = this.outputScale;
    for (let i = 0; i < N; i++) {
      this.accL[i] += re[i] * win[i] * scale;
      this.accR[i] += im[i] * win[i] * scale;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outLeft = output[0];
    const outRight = output[1] || output[0];
    const frames = outLeft.length;
    const inLeft = input && input.length > 0 ? input[0] : null;
    const inRight = input && input.length > 1 ? input[1] : inLeft;
    const target = Math.abs(this.ratio - 1) > 1e-4 ? 1 : 0;

    for (let i = 0; i < frames; i++) {
      const l = inLeft ? inLeft[i] : 0;
      const r = inRight ? inRight[i] : 0;
      const pos = this.rover;
      this.inL[pos] = l;
      this.inR[pos] = r;

      // Dry signal delayed by the same latency as the processed one, so switching is seamless.
      const dryL = this.dryL[this.dryPos];
      const dryR = this.dryR[this.dryPos];
      this.dryL[this.dryPos] = l;
      this.dryR[this.dryPos] = r;
      this.dryPos = (this.dryPos + 1) & (FFT_SIZE - 1);
      const wetL = this.outL[pos - LATENCY];
      const wetR = this.outR[pos - LATENCY];

      if (this.mix < target) this.mix = Math.min(target, this.mix + CROSSFADE_STEP);
      else if (this.mix > target) this.mix = Math.max(target, this.mix - CROSSFADE_STEP);
      const mix = this.mix;
      outLeft[i] = dryL + (wetL - dryL) * mix;
      if (outRight !== outLeft) outRight[i] = dryR + (wetR - dryR) * mix;

      this.rover++;
      if (this.rover >= FFT_SIZE) {
        this.rover = LATENCY;
        this.processFrame();
        this.outL.set(this.accL.subarray(0, HOP));
        this.outR.set(this.accR.subarray(0, HOP));
        this.accL.copyWithin(0, HOP);
        this.accR.copyWithin(0, HOP);
        this.accL.fill(0, FFT_SIZE);
        this.accR.fill(0, FFT_SIZE);
        this.inL.copyWithin(0, HOP);
        this.inR.copyWithin(0, HOP);
      }
    }
    return true;
  }
}

registerProcessor("deezer-pitch-shift", PitchShiftProcessor);
