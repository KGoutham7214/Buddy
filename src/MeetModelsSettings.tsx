import { useEffect, useState } from "react";
import { buddy } from "./api/buddyClient";

const WHISPER_MODELS = ["base", "small", "medium"] as const;

export default function MeetModelsSettings() {
  const [whisperModel, setWhisperModel] = useState("small");
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [whisperReady, setWhisperReady] = useState(true);
  const [ollamaReady, setOllamaReady] = useState(true);

  useEffect(() => {
    void buddy.getMeetSettings().then((settings) => {
      if (!settings?.ok) return;
      setWhisperModel(settings.whisperModel || "small");
      setOllamaModel(settings.ollamaModel || "");
    });
    void buddy.checkMeetingDeps().then((deps) => {
      setWhisperReady(Boolean(deps.whisper?.ok));
      setOllamaReady(Boolean(deps.ollama?.ok));
      setOllamaModels(deps.ollama?.models || []);
    });
  }, []);

  return (
    <div className="settings-meet-models">
      <div className="settings-label">Meeting models</div>
      <p className="settings-hint">
        Whisper handles transcription. Ollama writes the summary.
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
          {WHISPER_MODELS.map((model) => (
            <option key={model} value={model}>
              {model}
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
