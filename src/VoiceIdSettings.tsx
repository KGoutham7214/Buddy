import { useEffect, useState } from "react";
import type { VoiceProfile } from "./domain/types";
import { buddy } from "./api/buddyClient";
import { captureMicPcm } from "./voiceCapture";
import { LOW_VOLUME_RMS, SPEECH_ABS_RMS } from "./pcm";
import { useConfirm } from "./ConfirmDialog";

type VoiceDeps = {
  speakers?: { ok: boolean; error?: string; backend?: string };
  qdrant?: { ok: boolean; error?: string };
};

type Props = {
  /** True while a meeting is recording/processing — blocks mic enroll/test */
  micBusy?: boolean;
};

export default function VoiceIdSettings({ micBusy = false }: Props) {
  const { confirm, dialog } = useConfirm();
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [deps, setDeps] = useState<VoiceDeps | null>(null);
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

  useEffect(() => {
    void buddy.listVoices().then(setVoices);
    void buddy.checkMeetingDeps().then((d) =>
      setDeps({ speakers: d.speakers, qdrant: d.qdrant })
    );
  }, []);

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
      for (let pass = 1; pass <= PASS_COUNT; pass++) {
        setEnrollPass(pass);
        setEnrollLeft(PASS_SECONDS);
        setLevelRms(0);
        setEnrollHint(
          `Pass ${pass}/${PASS_COUNT}: say anything — words do not matter`
        );
        const captured = await captureMicPcm(
          PASS_SECONDS,
          setEnrollLeft,
          setLevelRms
        );
        rmsScores.push(captured.rms);
        if (!captured.voiced) {
          setEnrollError(
            `Pass ${pass} heard no speech on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Keep the headset mic and speak a bit more.`
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
      });
      if (!result.ok) {
        setEnrollError(result.error || "Could not save this voice");
        return;
      }
      const avgRms = rmsScores.reduce((a, b) => a + b, 0) / rmsScores.length;
      const quietNote = avgRms < LOW_VOLUME_RMS ? ", low volume" : "";
      setEnrollHint(
        `Saved ${name} (${PASS_COUNT} clean passes, avg rms ${avgRms.toFixed(3)}${quietNote})`
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
      if (!captured.voiced) {
        setTestResult(
          `Didn't hear speech on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Speak a bit more, or check the headset mic.`
        );
        return;
      }
      const result = await buddy.identifySpeaker({
        pcm: captured.pcm,
        sampleRate: 16000,
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
        Enroll names so meetings can show who is speaking. Matching uses the
        sound of the voice, not the words.
      </p>

      {voices.length === 0 ? (
        <p className="voices-hint">No voices enrolled yet.</p>
      ) : (
        <ul className="voice-list settings-voice-list">
          {voices.map((voice) => (
            <li key={voice.id} className="voice-row">
              <span className="voice-name">{voice.name}</span>
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
          Re-enroll these names — they were saved with an older matcher.
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
