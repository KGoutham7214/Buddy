import { downmixBuffer } from "./audioInput";

const WORKLET_NAME = "buddy-voice-tap";

const WORKLET_SRC = `
class BuddyVoiceTap extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0]) return true;
    const frames = channels[0].length;
    const out = new Float32Array(frames);
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      if (!data) continue;
      for (let i = 0; i < frames; i++) out[i] += data[i];
    }
    const n = channels.length;
    if (n > 1) {
      const inv = 1 / n;
      for (let i = 0; i < frames; i++) out[i] *= inv;
    }
    this.port.postMessage(out);
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", BuddyVoiceTap);
`;

let workletUrl = "";
const workletReady = new WeakSet<AudioContext>();

function workletModuleUrl() {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "application/javascript" })
    );
  }
  return workletUrl;
}

export type VoiceTap = {
  stop: () => void;
};

export async function attachVoiceTap(
  context: AudioContext,
  stream: MediaStream,
  onSamples: (samples: Float32Array) => void
): Promise<VoiceTap> {
  const source = context.createMediaStreamSource(stream);
  const mute = context.createGain();
  mute.gain.value = 0;

  try {
    if (!context.audioWorklet) throw new Error("no worklet");
    if (!workletReady.has(context)) {
      await context.audioWorklet.addModule(workletModuleUrl());
      workletReady.add(context);
    }
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (ev) => {
      const data = ev.data;
      if (data instanceof Float32Array) onSamples(data);
    };
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    return {
      stop: () => {
        try {
          node.port.onmessage = null;
          node.disconnect();
          source.disconnect();
          mute.disconnect();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    const inputChannels = Math.max(1, source.channelCount || 1);
    const proc = context.createScriptProcessor(4096, inputChannels, 1);
    proc.onaudioprocess = (ev) => {
      onSamples(downmixBuffer(ev.inputBuffer));
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(context.destination);
    return {
      stop: () => {
        try {
          proc.disconnect();
          source.disconnect();
          mute.disconnect();
        } catch {
          // ignore
        }
      },
    };
  }
}
