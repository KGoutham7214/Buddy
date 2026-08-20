const TARGET_RATE = 16000;
export const MIN_ABS_RMS = 0.006;
export const VAD_NOISE_MULT = 3;
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

export function noiseFloor(
  samples: Float32Array,
  sampleRate: number,
  windowSeconds = 0.3
): number {
  const hop = Math.max(1, Math.floor(sampleRate * 0.02));
  const limit = Math.min(samples.length, Math.floor(sampleRate * windowSeconds));
  if (limit < hop) return Math.max(MIN_ABS_RMS, rmsFloat32(samples));
  const floors: number[] = [];
  for (let start = 0; start + hop <= limit; start += hop) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const x = samples[start + i];
      sum += x * x;
    }
    floors.push(Math.sqrt(sum / hop));
  }
  floors.sort((a, b) => a - b);
  const quiet = floors[Math.floor(floors.length * 0.2)] || floors[0] || 0;
  return Math.max(MIN_ABS_RMS, quiet);
}

export function speechThreshold(noise: number): number {
  return Math.max(MIN_ABS_RMS, noise * VAD_NOISE_MULT);
}

export function hasVoicedFrames(
  samples: Float32Array,
  sampleRate: number
): boolean {
  const threshold = speechThreshold(noiseFloor(samples, sampleRate));
  const hop = Math.max(1, Math.floor(sampleRate * 0.02));
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const x = samples[start + i];
      sum += x * x;
    }
    if (Math.sqrt(sum / hop) >= threshold) return true;
  }
  return rmsFloat32(samples) >= threshold;
}

export function floatToInt16Pcm(
  input: Float32Array,
  fromRate: number,
  toRate = TARGET_RATE
): Int16Array {
  if (!input.length) return new Int16Array(0);
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const srcIndex = Math.min(input.length - 1, Math.floor(i * ratio));
    let s = input[srcIndex];
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
