import { useEffect, useState } from "react";
import type { VoiceProfile } from "./domain/types";
import { buddy } from "./api/buddyClient";
import { captureMicPcm } from "./voiceCapture";
import { LOW_VOLUME_RMS, SPEECH_ABS_RMS } from "./pcm";
import { useConfirm } from "./ConfirmDialog";

type VoiceDeps = {
  speakers?: { ok: boolean; error?: string; backend?: string; models?: string[] };
  qdrant?: { ok: boolean; error?: string };
};

type Props = {
  /** True while a meeting is recording/processing — blocks mic enroll/test */
  micBusy?: boolean;
};

const BACKEND_LABELS: Record<string, string> = {
  campplus: "CampPlus (default)",
  eres2net: "ERes2Net (stronger CPU)",
};

export default function VoiceIdSettings({ micBusy = false }: Props) {
  const { confirm, dialog } = useConfirm();
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [deps, setDeps] = useState<VoiceDeps | null>(null);
  const [speakerBackend, setSpeakerBackendState] = useState("campplus");
  const [backends, setBackends] = useState<string[]>(["campplus", "eres2net"]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [enrollName, setEnrollName] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollLeft, setEnrollLeft] = useState(12);
  const [enrollPass, setEnrollPass] = useState(0);
  const [enrollHint, setEnrollHint] = useState("");
  const [enrollError, setEnrollError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testLeft, setTestLeft] = useState(5);
  const [testResult, setTestResult] = useState("");
  const [levelRms, setLevelRms] = useState(0);
  const [lastDevice, setLastDevice] = useState("");

  useEffect(() => {
    void refreshAll();
  }, []);

  async function refreshAll() {
    setVoices(await buddy.listVoices());
    const [d, vs] = await Promise.all([
      buddy.checkMeetingDeps(),
      buddy.getVoiceSettings(),
    ]);
    setDeps({ speakers: d.speakers, qdrant: d.qdrant });
    if (vs?.ok) {
      setSpeakerBackendState(vs.speakerBackend || "campplus");
      if (Array.isArray(vs.backends) && vs.backends.length > 0) {
        setBackends(vs.backends);
      }
    }
  }

  async function refreshVoices() {
    setVoices(await buddy.listVoices());
  }

  async function removeVoice(id: string) {
    const voice = voices.find((v) => v.id === id);
    const label = voice?.name?.trim() || "this voice";
    const ok = await confirm({
      title: "Remove voice?",
      message: `“${label}” will be removed from Voice ID. You can enroll again later.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await buddy.deleteVoice(id);
    await refreshVoices();
  }

  async function clearAllVoices() {
    const ok = await confirm({
      title: "Clear all voices?",
      message:
        "All enrolled voices will be removed. Re-enroll on the same mic you use in meetings.",
      confirmLabel: "Clear & re-enroll",
    });
    if (!ok) return;
    const result = await buddy.clearVoices();
    if (!result.ok) {
      setEnrollError(result.error || "Could not clear voices");
      return;
    }
    setEnrollHint("Voices cleared — enroll again on your meeting mic.");
    setTestResult("");
    await refreshVoices();
  }

  async function changeBackend(next: string) {
    if (next === speakerBackend || switchingModel || enrolling || testing) return;
    const ok = await confirm({
      title: "Switch voice model?",
      message:
        next === "eres2net"
          ? "ERes2Net is stronger on CPU but clears saved voices. You will need to re-enroll."
          : "Switching models clears saved voices. You will need to re-enroll.",
      confirmLabel: "Switch model",
    });
    if (!ok) return;
    setSwitchingModel(true);
    setEnrollError("");
    try {
      const result = await buddy.setSpeakerBackend(next);
      if (!result.ok) {
        setEnrollError(result.error || "Could not switch model");
        return;
      }
      setSpeakerBackendState(result.speakerBackend || next);
      setEnrollHint(
        result.cleared
          ? `Switched to ${BACKEND_LABELS[next] || next}. Re-enroll voices on your meeting mic.`
          : `Using ${BACKEND_LABELS[next] || next}.`
      );
      await refreshAll();
    } finally {
      setSwitchingModel(false);
    }
  }

  async function enrollVoice() {
    const name = enrollName.trim();
    if (!name || enrolling || testing || micBusy) return;
    setEnrollError("");
    setEnrollHint("");
    setTestResult("");
    setEnrolling(true);
    setEnrollPass(0);
    setEnrollLeft(4);
    try {
      const PASS_COUNT = 3;
      const PASS_SECONDS = 4;
      const captures: Uint8Array[] = [];
      const rmsScores: number[] = [];
      let deviceLabel = "";
      for (let pass = 1; pass <= PASS_COUNT; pass++) {
        setEnrollPass(pass);
        setEnrollLeft(PASS_SECONDS);
        setLevelRms(0);
        setEnrollHint(
          `Pass ${pass}/${PASS_COUNT}: say anything — use the same headset as meetings`
        );
        const captured = await captureMicPcm(
          PASS_SECONDS,
          setEnrollLeft,
          setLevelRms
        );
        deviceLabel = captured.deviceLabel;
        setLastDevice(captured.deviceLabel);
        rmsScores.push(captured.rms);
        if (!captured.voiced || captured.rms < SPEECH_ABS_RMS) {
          setEnrollError(
            `Pass ${pass} too quiet on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Keep the headset mic closer and speak a bit more.`
          );
          return;
        }
        captures.push(captured.pcm);
      }
      if (rmsScores.length < PASS_COUNT) {
        setEnrollError("Couldn't capture enough clean speech. Try again.");
        return;
      }
      const result = await buddy.enrollVoice({
        name,
        passes: captures,
        sampleRate: 16000,
        deviceLabel,
        channel: "mic",
      });
      if (!result.ok) {
        setEnrollError(result.error || "Could not save this voice");
        return;
      }
      const avgRms = rmsScores.reduce((a, b) => a + b, 0) / rmsScores.length;
      const quietNote = avgRms < LOW_VOLUME_RMS ? ", low volume" : "";
      setEnrollHint(
        `Saved ${name} on ${deviceLabel} (${PASS_COUNT} passes, avg rms ${avgRms.toFixed(3)}${quietNote})`
      );
      setEnrollName("");
      await refreshVoices();
    } catch (err) {
      setEnrollError(
        err instanceof Error ? err.message : "Microphone unavailable"
      );
    } finally {
      setEnrollPass(0);
      setEnrolling(false);
      setLevelRms(0);
    }
  }

  async function testVoice() {
    if (enrolling || testing || micBusy) return;
    setEnrollError("");
    setTestResult("");
    setTesting(true);
    setTestLeft(5);
    setLevelRms(0);
    try {
      await buddy.resetSpeakerSession();
      const captured = await captureMicPcm(5, setTestLeft, setLevelRms);
      setLastDevice(captured.deviceLabel);
      if (!captured.voiced || captured.rms < SPEECH_ABS_RMS) {
        setTestResult(
          `Didn't hear speech on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Speak a bit more, or check the headset mic.`
        );
        return;
      }
      const result = await buddy.identifySpeaker({
        pcm: captured.pcm,
        sampleRate: 16000,
        channel: "mic",
      });
      if (!result.ok) {
        setTestResult(result.error || "Could not identify this voice");
        return;
      }
      const score =
        typeof result.confidence === "number"
          ? `score ${result.confidence.toFixed(2)}`
          : "";
      const closest = result.diagnostics?.topLabel
        ? ` vs ${result.diagnostics.topLabel}`
        : "";
      const floor =
        typeof result.diagnostics?.floor === "number"
          ? `, floor ${result.diagnostics.floor.toFixed(2)}`
          : "";
      const quiet = captured.rms < LOW_VOLUME_RMS ? " · low volume" : "";
      const mic = ` · ${captured.deviceLabel} · rms ${captured.rms.toFixed(3)}${quiet}`;
      const relaxed = result.diagnostics?.relaxedSingle
        ? ", relaxed single-speaker match"
        : "";
      setTestResult(
        result.speech === false || result.kind === "silence"
          ? `Didn't hear speech on ${captured.deviceLabel}.`
          : result.kind === "enrolled" && result.label
            ? `Heard: ${result.label} (${score}${floor}${relaxed})${mic}`
            : `Unknown (${score}${closest}${floor}) — re-enroll on this same mic${mic}`
      );
    } catch (err) {
      setTestResult(
        err instanceof Error ? err.message : "Microphone unavailable"
      );
    } finally {
      setTesting(false);
      setLevelRms(0);
    }
  }

  const blocked =
    Boolean(deps && deps.speakers && !deps.speakers.ok) ||
    Boolean(deps && deps.qdrant && !deps.qdrant.ok);

  return (
    <div className="settings-voices">
      {dialog}
      <div className="settings-label">Voice ID</div>
      <p className="settings-hint voices-hint-inline">
        Enroll on the same headset mic you use in meetings. Matching uses the
        sound of the voice, not the words. Runs locally on CPU (ONNX).
      </p>

      <div className="voice-enroll" style={{ marginBottom: 8 }}>
        <label className="settings-hint" htmlFor="voice-backend">
          Encoder
        </label>
        <select
          id="voice-backend"
          className="voice-name-input"
          value={speakerBackend}
          disabled={switchingModel || enrolling || testing || micBusy}
          onChange={(e) => void changeBackend(e.target.value)}
        >
          {backends.map((id) => (
            <option key={id} value={id}>
              {BACKEND_LABELS[id] || id}
            </option>
          ))}
        </select>
      </div>

      {lastDevice ? (
        <p className="voices-hint">Last mic: {lastDevice}</p>
      ) : null}

      {voices.length === 0 ? (
        <p className="voices-hint">No voices enrolled yet.</p>
      ) : (
        <ul className="voice-list settings-voice-list">
          {voices.map((voice) => (
            <li key={voice.id} className="voice-row">
              <span className="voice-name">
                {voice.name}
                {voice.deviceLabel ? (
                  <span className="voices-hint"> · {voice.deviceLabel}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="btn btn-ghost voice-delete"
                onClick={() => void removeVoice(voice.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {deps?.speakers?.backend &&
      voices.some(
        (v) => v.backend && v.backend !== deps.speakers?.backend
      ) ? (
        <p className="voices-hint">
          Re-enroll these names — they were saved with a different encoder.
        </p>
      ) : null}

      <div className="voice-enroll">
        <input
          className="voice-name-input"
          value={enrollName}
          onChange={(e) => setEnrollName(e.target.value)}
          placeholder="Name"
          disabled={enrolling || testing || micBusy}
          maxLength={40}
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void enrollVoice()}
          disabled={
            enrolling ||
            testing ||
            micBusy ||
            !enrollName.trim() ||
            blocked
          }
        >
          {enrolling
            ? `Pass ${Math.max(enrollPass, 1)}/3… ${enrollLeft}s`
            : "Enroll"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void testVoice()}
          disabled={enrolling || testing || micBusy || blocked}
        >
          {testing ? `Listening… ${testLeft}s` : "Test"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void clearAllVoices()}
          disabled={enrolling || testing || micBusy || voices.length === 0}
        >
          Clear voices
        </button>
      </div>

      {micBusy ? (
        <p className="voices-hint">Finish or cancel the meeting recording first.</p>
      ) : null}

      {enrolling || testing ? (
        <div className="voice-meter" aria-hidden>
          <span className="voice-meter-label">
            {levelRms >= SPEECH_ABS_RMS ? "Speech" : "Too quiet"}
          </span>
          <span className="voice-meter-track">
            <span
              className={`voice-meter-fill ${levelRms >= SPEECH_ABS_RMS ? "ok" : ""}`}
              style={{
                width: `${Math.min(100, Math.round((levelRms / 0.08) * 100))}%`,
              }}
            />
          </span>
        </div>
      ) : null}

      {testResult ? <div className="voices-test">{testResult}</div> : null}
      {enrollHint ? <div className="voices-test">{enrollHint}</div> : null}
      {enrollError ? <div className="voices-error">{enrollError}</div> : null}
      {deps?.speakers && !deps.speakers.ok ? (
        <p className="voices-hint">{deps.speakers.error}</p>
      ) : null}
      {deps?.qdrant && !deps.qdrant.ok ? (
        <p className="voices-hint">{deps.qdrant.error}</p>
      ) : null}
    </div>
  );
}
