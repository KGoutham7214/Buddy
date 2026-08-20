import {
  concatFloat32,
  floatToInt16Pcm,
  hasVoicedFrames,
  pcmToBytes,
  rmsFloat32,
  rmsInt16,
} from "./pcm";
import { openPreferredMicStream } from "./audioInput";
import { attachVoiceTap } from "./voiceTap";

const WARMUP_SECONDS = 0.35;

export async function captureMicPcm(
  seconds: number,
  onTick?: (left: number) => void,
  onLevel?: (rms: number) => void
): Promise<{
  pcm: Uint8Array;
  rms: number;
  deviceLabel: string;
  voiced: boolean;
}> {
  const picked = await openPreferredMicStream();
  const stream = picked.stream;
  const ctx = new AudioContext();
  await ctx.resume();
  const samples: Float32Array[] = [];
  let tap: { stop: () => void } | null = null;
  try {
    tap = await attachVoiceTap(ctx, stream, (chunk) => {
      samples.push(new Float32Array(chunk));
      onLevel?.(rmsFloat32(chunk));
    });

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = window.setInterval(() => {
        const left = Math.max(
          0,
          seconds - Math.floor((Date.now() - started) / 1000)
        );
        onTick?.(left);
        if (left === 0) {
          window.clearInterval(tick);
          resolve();
        }
      }, 200);
    });

    tap.stop();
    tap = null;
    const merged = concatFloat32(samples);
    const skip = Math.min(
      merged.length,
      Math.floor(ctx.sampleRate * WARMUP_SECONDS)
    );
    const trimmed = merged.subarray(skip);
    const pcm = floatToInt16Pcm(trimmed, ctx.sampleRate);
    return {
      pcm: pcmToBytes(pcm),
      rms: rmsInt16(pcm),
      deviceLabel: picked.label,
      voiced: hasVoicedFrames(trimmed, ctx.sampleRate),
    };
  } finally {
    tap?.stop();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }
}
