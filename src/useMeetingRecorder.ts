import { useEffect, useRef, useState } from "react";

export type RecordPhase = "idle" | "recording" | "processing";

export type MeetingRecorder = {
  phase: RecordPhase;
  elapsed: number;
  status: string;
  error: string;
  captureInfo: string;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => void;
  clearStatus: () => void;
  clearError: () => void;
};

export function useMeetingRecorder(): MeetingRecorder {
  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [captureInfo, setCaptureInfo] = useState("");

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

  function cleanupStreams() {
    const state = mediaRef.current;
    state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    state.streams = [];
    if (state.context) {
      void state.context.close();
      state.context = null;
    }
    state.recorder = null;
    state.chunks = [];
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

  async function startRecording() {
    setError("");
    setStatus("");
    setCaptureInfo("");
    setElapsed(0);

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const systemStream = await getSystemAudioStream();

      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(micStream).connect(destination);

      const streams = [micStream];
      if (systemStream) {
        context.createMediaStreamSource(systemStream).connect(destination);
        streams.push(systemStream);
        setCaptureInfo("Mic + system audio");
      } else {
        setCaptureInfo("Mic only (system audio unavailable)");
      }

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
      return null;
    }

    setPhase("processing");
    setStatus("Saving audio…");

    const blob: Blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(state.chunks, { type: recorder.mimeType }));
      };
      recorder.stop();
    });

    cleanupStreams();

    try {
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const result = await window.buddy.processMeeting({
        buffer,
        mimeType: blob.type || "audio/webm",
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
  }

  return {
    phase,
    elapsed,
    status,
    error,
    captureInfo,
    startRecording,
    stopRecording,
    cancelRecording,
    clearStatus: () => setStatus(""),
    clearError: () => setError(""),
  };
}
