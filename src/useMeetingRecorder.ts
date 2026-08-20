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

const WINDOW_SECONDS = 2.5;
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
    return window.buddy?.onMeetingProgress((message) => setStatus(message));
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    const active = phase === "recording" || phase === "processing";
    void window.buddy?.setRecording?.(active);
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
      const sourceId = await window.buddy.getDesktopSource();
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
    const hold = { label: "", score: 0, at: 0 };
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

    function applyResult(result: IdentifyResult | null, heardSpeech: boolean) {
      const now = Date.now();
      const silent =
        !heardSpeech ||
        !result ||
        result.speech === false ||
        result.kind === "silence";
      if (silent) {
        if (!hold.label || now - hold.at > HOLD_MS) {
          hold.label = "";
          hold.score = 0;
          setLiveSpeaker("");
          setLiveSpeakerState("listening");
        }
        return;
      }
      if (result.ok && result.kind === "enrolled" && result.label) {
        const label = result.label;
        const score = result.confidence ?? 0;
        const switchOk =
          !hold.label ||
          hold.label === label ||
          score - hold.score >= SWITCH_MARGIN;
        if (switchOk) {
          hold.label = label;
          hold.score = score;
          hold.at = now;
          setLiveSpeaker(label);
          setLiveSpeakerState("name");
          recordTurn(result);
          setLiveSpeakerTrail((prev) => {
            const next = prev.filter((name) => name !== label);
            next.push(label);
            return next.slice(-4);
          });
        } else {
          hold.at = now;
        }
        return;
      }
      if (!hold.label || now - hold.at > HOLD_MS) {
        hold.label = "";
        hold.score = 0;
        hold.at = now;
        setLiveSpeaker("");
        setLiveSpeakerState("unknown");
        if (result.ok && result.label) recordTurn(result);
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
            applyResult(null, false);
            continue;
          }
          if (!window.buddy?.identifySpeaker) continue;
          const result = await window.buddy.identifySpeaker({
            pcm: sample.pcm,
            sampleRate: 16000,
          });
          if (result.ok && result.kind === "enrolled" && result.label) {
            applyResult(result, true);
            continue;
          }
          applyResult(
            result.ok && result.speech !== false && result.kind !== "silence"
              ? result
              : { ok: true, kind: "silence", speech: false },
            Boolean(
              result.ok && result.speech !== false && result.kind !== "silence"
            )
          );
        }
      } finally {
        identifyBusy.current = false;
        if (identifyQueue.current.length > 0) void drainQueue();
      }
    }

    async function tapStream(stream: MediaStream) {
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

    void tapStream(mic);
    if (system) void tapStream(system);
  }

  async function startRecording() {
    setError("");
    setStatus("");
    setCaptureInfo("");
    setElapsed(0);
    resetLiveSpeaker();

    try {
      await window.buddy.resetSpeakerSession?.();
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
    resetLiveSpeaker();

    const blob: Blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(state.chunks, { type: recorder.mimeType }));
      };
      recorder.stop();
    });

    cleanupStreams();

    try {
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const turns = liveTurnsRef.current.slice();
      const result = await window.buddy.processMeeting({
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
