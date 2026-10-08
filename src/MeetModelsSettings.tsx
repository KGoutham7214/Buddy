import { useEffect, useState } from "react";
import { buddy } from "./api/buddyClient";

const MODEL_LABELS: Record<string, string> = {
  "distil-small.en": "distil-small.en (recommended)",
  small: "small",
  "small.en": "small.en (more accurate)",
  "distil-medium.en": "distil-medium.en (slower, better)",
  medium: "medium (slow)",
  "medium.en": "medium.en (slow)",
};

const BEAM_LABELS: Record<number, string> = {
  1: "1 — fastest",
  2: "2 — balanced",
  5: "5 — slower, slightly better",
};

export default function MeetModelsSettings() {
  const [whisperModel, setWhisperModel] = useState("distil-small.en");
  const [whisperBeamSize, setWhisperBeamSize] = useState(1);
  const [whisperModels, setWhisperModels] = useState<string[]>(
    Object.keys(MODEL_LABELS)
  );
  const [whisperBeamSizes, setWhisperBeamSizes] = useState<number[]>([1, 2, 5]);
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [whisperReady, setWhisperReady] = useState(true);
  const [ollamaReady, setOllamaReady] = useState(true);
  const [diarizationBackend, setDiarizationBackend] = useState("off");
  const [diarReady, setDiarReady] = useState(false);
  const [diarError, setDiarError] = useState("");
  const [downloadingDiar, setDownloadingDiar] = useState(false);

  useEffect(() => {
    void buddy.getMeetSettings().then((settings) => {
      if (!settings?.ok) return;
      setWhisperModel(settings.whisperModel || "distil-small.en");
      setWhisperBeamSize(settings.whisperBeamSize ?? 1);
      if (Array.isArray(settings.whisperModels) && settings.whisperModels.length) {
        setWhisperModels(settings.whisperModels);
      }
      if (
        Array.isArray(settings.whisperBeamSizes) &&
        settings.whisperBeamSizes.length
      ) {
        setWhisperBeamSizes(settings.whisperBeamSizes);
      }
      setOllamaModel(settings.ollamaModel || "");
      setDiarizationBackend(settings.diarizationBackend || "off");
    });
    void buddy.checkMeetingDeps().then((deps) => {
      setWhisperReady(Boolean(deps.whisper?.ok));
      setOllamaReady(Boolean(deps.ollama?.ok));
      setOllamaModels(deps.ollama?.models || []);
      setDiarReady(Boolean(deps.diarization?.ok));
      setDiarError(deps.diarization?.error || "");
    });
  }, []);

  return (
    <div className="settings-meet-models">
      <div className="settings-label">Meeting models</div>
      <p className="settings-hint">
        Whisper handles transcription (kept warm after launch). Prefer English
        distil models on CPU. Ollama writes the summary.
      </p>

      <label className="settings-field">
        <span className="settings-field-label">Whisper</span>
        <select
          className="settings-select"
          value={whisperModel}
          disabled={!whisperReady}
          onChange={(e) => {
            const next = e.target.value;
            setWhisperModel(next);
            void buddy.setMeetSettings({ whisperModel: next });
          }}
        >
          {whisperModels.map((model) => (
            <option key={model} value={model}>
              {MODEL_LABELS[model] || model}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Whisper beam</span>
        <select
          className="settings-select"
          value={String(whisperBeamSize)}
          disabled={!whisperReady}
          onChange={(e) => {
            const next = Number(e.target.value) || 1;
            setWhisperBeamSize(next);
            void buddy.setMeetSettings({ whisperBeamSize: next });
          }}
        >
          {whisperBeamSizes.map((beam) => (
            <option key={beam} value={beam}>
              {BEAM_LABELS[beam] || String(beam)}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Ollama</span>
        <select
          className="settings-select"
          value={ollamaModel}
          disabled={!ollamaReady}
          onChange={(e) => {
            const next = e.target.value;
            setOllamaModel(next);
            void buddy.setMeetSettings({ ollamaModel: next });
          }}
        >
          <option value="">Auto (prefer llama3.2)</option>
          {ollamaModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Neural diarization</span>
        <select
          className="settings-select"
          value={diarizationBackend}
          onChange={(e) => {
            const next = e.target.value;
            setDiarizationBackend(next);
            void buddy.setMeetSettings({ diarizationBackend: next });
          }}
        >
          <option value="off">Off (cluster labeling)</option>
          <option value="nemotron">Nemotron-3 (CPU)</option>
        </select>
      </label>
      {diarizationBackend === "nemotron" ? (
        <div className="settings-field">
          <p className="voices-hint">
            {diarReady
              ? "Nemotron is ready. Post-meeting turns use it; Voice ID still names people."
              : diarError || "Nemotron runtime is not downloaded yet."}
          </p>
          {!diarReady ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={downloadingDiar}
              onClick={() => {
                setDownloadingDiar(true);
                setDiarError("");
                void buddy
                  .downloadDiarization()
                  .then((result) => {
                    if (!result.ok) {
                      setDiarError(result.error || "Download failed");
                      setDiarReady(false);
                      return;
                    }
                    setDiarReady(true);
                  })
                  .catch((err) => {
                    setDiarError(
                      err instanceof Error ? err.message : "Download failed"
                    );
                  })
                  .finally(() => setDownloadingDiar(false));
              }}
            >
              {downloadingDiar ? "Downloading…" : "Download Nemotron"}
            </button>
          ) : null}
        </div>
      ) : null}

      {!whisperReady || !ollamaReady ? (
        <p className="voices-hint">
          {[
            !whisperReady ? "Whisper is not ready." : "",
            !ollamaReady ? "Ollama is not running or has no models." : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
    </div>
  );
}
