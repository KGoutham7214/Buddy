const MIC_CONSTRAINTS_BASE: MediaTrackConstraints = {
  // Speaker ID needs the raw mic. Headset AEC often zeros or warps speech.
  // Keep AGC on so quiet headsets still clear the speech gate.
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

type MicPick = {
  stream: MediaStream;
  label: string;
  source: "ranked" | "default" | "fallback";
};

function scoreInputDevice(device: MediaDeviceInfo): number {
  const id = device.deviceId;
  const label = (device.label || "").toLowerCase();
  if (
    /stereo mix|loopback|what u hear|cable output|vb-audio|virtual cable|nvidia broadcast/.test(
      label
    )
  ) {
    return -1000;
  }
  let score = 0;
  if (/headset|headphone|earphone|earbuds|airpods|hands-free/.test(label)) {
    score += 50;
  }
  if (id === "default") score += 30;
  if (/usb/.test(label)) score += 16;
  if (/microphone|mic/.test(label)) score += 10;
  if (/array|laptop|internal|built-in/.test(label)) score += 8;
  if (id === "communications") score += 4;
  return score;
}

async function openMicWithConstraints(
  audio: boolean | MediaTrackConstraints
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio });
}

export async function openPreferredMicStream(): Promise<MicPick> {
  const probe = await openMicWithConstraints({
    ...MIC_CONSTRAINTS_BASE,
  });
  const probeLabel = probe.getAudioTracks()[0]?.label || "Microphone";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const ranked = devices
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ device: d, score: scoreInputDevice(d) }))
      .filter((d) => d.score > -500)
      .sort((a, b) => b.score - a.score);

    for (const item of ranked) {
      const id = item.device.deviceId;
      if (!id || id === "default" || id === "communications") continue;
      try {
        const stream = await openMicWithConstraints({
          ...MIC_CONSTRAINTS_BASE,
          deviceId: { exact: id },
        });
        const track = stream.getAudioTracks()[0];
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          continue;
        }
        probe.getTracks().forEach((t) => t.stop());
        return {
          stream,
          label: track.label || item.device.label || "Microphone",
          source: "ranked",
        };
      } catch {
        // try next device
      }
    }
  } catch {
    // fall through to the permission probe stream
  }

  return { stream: probe, label: probeLabel, source: "fallback" };
}

export function downmixBuffer(buffer: AudioBuffer): Float32Array {
  const frames = buffer.length;
  const channels = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] += data[i];
  }
  if (channels > 1) {
    const inv = 1 / channels;
    for (let i = 0; i < frames; i++) out[i] *= inv;
  }
  return out;
}
