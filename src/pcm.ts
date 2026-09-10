const TARGET_RATE = 16000;
export const MIN_ABS_RMS = 0.004;
export const VAD_NOISE_MULT = 2;
export const SPEECH_ABS_RMS = 0.008;
export const LOW_VOLUME_RMS = 0.03;

export function rmsFloat32(samples: Float32Array | number[]): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    sum += x * x;
  }
  return Math.sqrt(sum / n);
}

function frameRmsRegion(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number
): number[] {
  const hop = Math.max(1, Math.floor(sampleRate * 0.02));
  const floors: number[] = [];
  for (let i = start; i + hop <= end; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const x = samples[i + j];
      sum += x * x;
    }
    floors.push(Math.sqrt(sum / hop));
  }
  return floors;
}

export function noiseFloor(
  samples: Float32Array,
  sampleRate: number,
  windowSeconds = 0.3
): number {
  const overall = rmsFloat32(samples);
  if (overall < 1e-8) return MIN_ABS_RMS;
  const probe = Math.min(
    samples.length,
    Math.floor(sampleRate * windowSeconds)
  );
  const floors = frameRmsRegion(samples, sampleRate, 0, probe);
  if (samples.length > probe * 2) {
    const mid = Math.floor(samples.length / 2);
    floors.push(
      ...frameRmsRegion(
        samples,
        sampleRate,
        mid,
        Math.min(samples.length, mid + probe)
      )
    );
  }
  if (samples.length > probe) {
    floors.push(
      ...frameRmsRegion(
        samples,
        sampleRate,
        Math.max(0, samples.length - probe),
        samples.length
      )
    );
  }
  if (!floors.length) return MIN_ABS_RMS;
  floors.sort((a, b) => a - b);
  const quiet = floors[Math.floor(floors.length * 0.2)] || floors[0] || 0;
  // Continuous speech: quiet ≈ overall → use absolute floor, not 2–3x speech.
  if (quiet >= overall * 0.45) return MIN_ABS_RMS;
  return Math.max(MIN_ABS_RMS, Math.min(quiet, overall * 0.4));
}

export function speechThreshold(noise: number, signal?: number): number {
  let thr = Math.max(SPEECH_ABS_RMS, noise * VAD_NOISE_MULT);
  if (typeof signal === "number" && signal > 0) {
    thr = Math.min(thr, Math.max(SPEECH_ABS_RMS, signal * 0.4));
  }
  return thr;
}

export function hasVoicedFrames(
  samples: Float32Array,
  sampleRate: number
): boolean {
  const overall = rmsFloat32(samples);
  if (overall >= SPEECH_ABS_RMS) return true;
  const threshold = speechThreshold(noiseFloor(samples, sampleRate), overall);
  const hop = Math.max(1, Math.floor(sampleRate * 0.02));
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const x = samples[start + i];
      sum += x * x;
    }
    if (Math.sqrt(sum / hop) >= threshold) return true;
  }
  return overall >= threshold;
}

export function floatToInt16Pcm(
  input: Float32Array,
  fromRate: number,
  toRate = TARGET_RATE
): Int16Array {
  if (!input.length) return new Int16Array(0);
  if (!fromRate || fromRate === toRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = input[i];
      if (s > 1) s = 1;
      if (s < -1) s = -1;
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(length);
  const last = input.length - 1;
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const frac = src - i0;
    let s = input[i0] * (1 - frac) + input[i1] * frac;
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function pcmToBytes(pcm: Int16Array): Uint8Array {
  const view = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

export function rmsInt16(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i] / 32768;
    sum += x * x;
  }
  return Math.sqrt(sum / pcm.length);
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, a) => n + a.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
