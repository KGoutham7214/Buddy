import { useEffect, useRef, useState } from "react";
import {
  concatFloat32,
  floatToInt16Pcm,
  hasVoicedFrames,
  pcmToBytes,
  rmsInt16,
} from "./pcm";
import { openPreferredMicStream } from "./audioInput";
import { attachVoiceTap, type VoiceTap } from "./voiceTap";
import { buddy, hasBuddyApi } from "./api/buddyClient";

export type RecordPhase = "idle" | "recording" | "processing";
export type LiveSpeakerState = "listening" | "name" | "unknown";

export type MeetingRecorder = {
  phase: RecordPhase;
  elapsed: number;
  status: string;
  error: string;
  captureInfo: string;
  liveSpeaker: string;
  liveSpeakerState: LiveSpeakerState;
  liveSpeakerTrail: string[];
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => void;
  clearStatus: () => void;
  clearError: () => void;
};

const WINDOW_SECONDS = 2.0;
const HOLD_MS = 1200;
const SWITCH_MARGIN = 0.05;
const MAX_IDENTIFY_QUEUE = 4;

export type SpeakerTurn = {
  label: string;
  kind: "enrolled" | "unknown";
  confidence: number;
  start: number;
  end: number;
};

type IdentifyResult = {
  ok: boolean;
  speech?: boolean;
  label?: string | null;
  kind?: "enrolled" | "unknown" | "silence";
  confidence?: number;
};

type PcmSample = {
  pcm: Uint8Array;
  rms: number;
  voiced: boolean;
  channel: "mic" | "system";
};

export function nowSpeakingLabel(
  state: LiveSpeakerState,
  name: string
): string {
  if (state === "name" && name) return name;
  if (state === "unknown") return "Unknown voice";
  return "Listening…";
}

export function useMeetingRecorder(): MeetingRecorder {
  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [captureInfo, setCaptureInfo] = useState("");
  const [liveSpeaker, setLiveSpeaker] = useState("");
  const [liveSpeakerState, setLiveSpeakerState] =
    useState<LiveSpeakerState>("listening");
  const [liveSpeakerTrail, setLiveSpeakerTrail] = useState<string[]>([]);
  const identifyBusy = useRef(false);
  const liveTurnsRef = useRef<SpeakerTurn[]>([]);
  const startedAtRef = useRef(0);
  const tapsRef = useRef<VoiceTap[]>([]);
  const identifyQueue = useRef<PcmSample[]>([]);

  const mediaRef = useRef<{
    recorder: MediaRecorder | null;
    streams: MediaStream[];
    context: AudioContext | null;
    chunks: Blob[];
  }>({ recorder: null, streams: [], context: null, chunks: [] });

  useEffect(() => {
    if (!hasBuddyApi()) return;
    return buddy.onMeetingProgress((message) => setStatus(message));
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (!hasBuddyApi()) return;
    const active = phase === "recording" || phase === "processing";
    void buddy.setRecording(active);
  }, [phase]);

  function resetLiveSpeaker() {
    setLiveSpeaker("");
    setLiveSpeakerState("listening");
    setLiveSpeakerTrail([]);
    liveTurnsRef.current = [];
    identifyQueue.current = [];
  }

  function cleanupStreams() {
    const state = mediaRef.current;
    tapsRef.current.forEach((tap) => tap.stop());
    tapsRef.current = [];
    state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    state.streams = [];
    if (state.context) {
      void state.context.close();
      state.context = null;
    }
    state.recorder = null;
    state.chunks = [];
    identifyBusy.current = false;
    identifyQueue.current = [];
  }

  async function getSystemAudioStream(): Promise<MediaStream | null> {
    try {
      const sourceId = await buddy.getDesktopSource();
      if (!sourceId) return null;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-expect-error Chromium desktop capture constraints
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        },
        video: {
          // @ts-expect-error Chromium desktop capture constraints
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxWidth: 2,
            maxHeight: 2,
          },
        },
      });

      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      return stream.getAudioTracks().length > 0 ? stream : null;
    } catch {
      return null;
    }
  }

  function attachLiveIdentify(
    context: AudioContext,
    mic: MediaStream,
    system: MediaStream | null
  ) {
    const hold = {
      mic: { label: "", score: 0, at: 0 },
      system: { label: "", score: 0, at: 0 },
    };
    const windowSamples = Math.floor(context.sampleRate * WINDOW_SECONDS);

    function recordTurn(result: IdentifyResult) {
      if (!result.label || (result.kind !== "enrolled" && result.kind !== "unknown")) {
        return;
      }
      const end = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
      const start = Math.max(0, end - WINDOW_SECONDS);
      liveTurnsRef.current.push({
        label: result.label,
        kind: result.kind,
        confidence: result.confidence ?? 0,
        start,
        end,
      });
    }

    function publishUi(
      channel: "mic" | "system",
      state: LiveSpeakerState,
      label: string
    ) {
      // Prefer mic identity for the floating label; system fills when mic is quiet.
      if (channel === "system" && hold.mic.label && Date.now() - hold.mic.at < HOLD_MS) {
        return;
      }
      setLiveSpeaker(label);
      setLiveSpeakerState(state);
      if (label) {
        setLiveSpeakerTrail((prev) => {
          const next = prev.filter((name) => name !== label);
          next.push(label);
          return next.slice(-4);
        });
      }
    }

    function applyResult(
      result: IdentifyResult | null,
      heardSpeech: boolean,
      channel: "mic" | "system"
    ) {
      const now = Date.now();
      const slot = hold[channel];
      const silent =
        !heardSpeech ||
        !result ||
        result.speech === false ||
        result.kind === "silence";
      if (silent) {
        if (!slot.label || now - slot.at > HOLD_MS) {
          slot.label = "";
          slot.score = 0;
          if (channel === "mic" || !hold.mic.label) {
            publishUi(channel, "listening", "");
          }
        }
        return;
      }
      if (result.ok && result.kind === "enrolled" && result.label) {
        const label = result.label;
        const score = result.confidence ?? 0;
        const switchOk =
          !slot.label ||
          slot.label === label ||
          score - slot.score >= SWITCH_MARGIN;
        if (switchOk) {
          slot.label = label;
          slot.score = score;
          slot.at = now;
          publishUi(channel, "name", label);
          recordTurn(result);
        } else {
          slot.at = now;
        }
        return;
      }
      if (!slot.label || now - slot.at > HOLD_MS) {
        slot.label = "";
        slot.score = 0;
        slot.at = now;
        if (result.ok && result.label) {
          recordTurn(result);
          publishUi(channel, "unknown", result.label);
        } else if (channel === "mic" || !hold.mic.label) {
          publishUi(channel, "unknown", "");
        }
      }
    }

    async function drainQueue() {
      if (identifyBusy.current) return;
      identifyBusy.current = true;
      try {
        while (identifyQueue.current.length > 0) {
          const sample = identifyQueue.current.shift();
          if (!sample) break;
          if (!sample.voiced) {
            applyResult(null, false, sample.channel);
            continue;
          }
          if (!hasBuddyApi()) continue;
          const result = await buddy.identifySpeaker({
            pcm: sample.pcm,
            sampleRate: 16000,
          });
          if (result.ok && result.kind === "enrolled" && result.label) {
            applyResult(result, true, sample.channel);
            continue;
          }
          applyResult(
            result.ok && result.speech !== false && result.kind !== "silence"
              ? result
              : { ok: true, kind: "silence", speech: false },
            Boolean(
              result.ok && result.speech !== false && result.kind !== "silence"
            ),
            sample.channel
          );
        }
      } finally {
        identifyBusy.current = false;
        if (identifyQueue.current.length > 0) void drainQueue();
      }
    }

    async function tapStream(stream: MediaStream, channel: "mic" | "system") {
      const pending: Float32Array[] = [];
      let pendingCount = 0;
      const tap = await attachVoiceTap(context, stream, (input) => {
        pending.push(new Float32Array(input));
        pendingCount += input.length;
        if (pendingCount < windowSamples) return;
        const merged = concatFloat32(pending);
        pending.length = 0;
        pendingCount = 0;
        const pcm = floatToInt16Pcm(merged, context.sampleRate);
        const sample: PcmSample = {
          pcm: pcmToBytes(pcm),
          rms: rmsInt16(pcm),
          voiced: hasVoicedFrames(merged, context.sampleRate),
          channel,
        };
        identifyQueue.current.push(sample);
        if (identifyQueue.current.length > MAX_IDENTIFY_QUEUE) {
          identifyQueue.current.splice(
            0,
            identifyQueue.current.length - MAX_IDENTIFY_QUEUE
          );
        }
        void drainQueue();
      });
      tapsRef.current.push(tap);
    }

    void tapStream(mic, "mic");
    if (system) void tapStream(system, "system");
  }

  async function startRecording() {
    setError("");
    setStatus("");
    setCaptureInfo("");
    setElapsed(0);
    resetLiveSpeaker();

    try {
      await buddy.resetSpeakerSession();
      const pickedMic = await openPreferredMicStream();
      const micStream = pickedMic.stream;
      const systemStream = await getSystemAudioStream();

      const context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(micStream).connect(destination);

      const streams = [micStream];
      if (systemStream) {
        context.createMediaStreamSource(systemStream).connect(destination);
        streams.push(systemStream);
        setCaptureInfo(`Mic + system audio (${pickedMic.label})`);
      } else {
        setCaptureInfo(`Mic only (${pickedMic.label})`);
      }

      startedAtRef.current = Date.now();
      liveTurnsRef.current = [];
      identifyQueue.current = [];
      attachLiveIdentify(context, micStream, systemStream);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(destination.stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRef.current = { recorder, streams, context, chunks };
      recorder.start(1000);
      setPhase("recording");
    } catch (err) {
      cleanupStreams();
      setError(
        err instanceof Error
          ? err.message
          : "Microphone permission denied or unavailable"
      );
      setPhase("idle");
    }
  }

  async function stopRecording(): Promise<string | null> {
    const state = mediaRef.current;
    const recorder = state.recorder;
    if (!recorder || recorder.state === "inactive") {
      cleanupStreams();
      setPhase("idle");
      resetLiveSpeaker();
      return null;
    }

    setPhase("processing");
    setStatus("Saving audio…");
    // Snapshot before clearing — resetLiveSpeaker() wipes liveTurnsRef
    const turns = liveTurnsRef.current.slice();
    setLiveSpeaker("");
    setLiveSpeakerState("listening");
    setLiveSpeakerTrail([]);
    identifyQueue.current = [];
    liveTurnsRef.current = [];

    const blob: Blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(state.chunks, { type: recorder.mimeType }));
      };
      recorder.stop();
    });

    cleanupStreams();

    try {
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const result = await buddy.processMeeting({
        buffer,
        mimeType: blob.type || "audio/webm",
        speakerTurns: turns,
      });

      if (!result.ok) {
        setError(result.error || "Failed to process meeting");
        setPhase("idle");
        setStatus("");
        return null;
      }

      if (result.aiError) {
        setStatus(`Saved transcript. AI summary skipped: ${result.aiError}`);
      } else {
        setStatus("Meeting note ready");
      }
      setPhase("idle");
      return result.noteId || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
      setPhase("idle");
      setStatus("");
      return null;
    }
  }

  function cancelRecording() {
    const state = mediaRef.current;
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.stop();
    }
    cleanupStreams();
    setPhase("idle");
    setElapsed(0);
    setStatus("");
    setCaptureInfo("");
    resetLiveSpeaker();
  }

  return {
    phase,
    elapsed,
    status,
    error,
    captureInfo,
    liveSpeaker,
    liveSpeakerState,
    liveSpeakerTrail,
    startRecording,
    stopRecording,
    cancelRecording,
    clearStatus: () => setStatus(""),
    clearError: () => setError(""),
  };
}
