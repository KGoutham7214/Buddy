const speakers = require("./speakers.cjs");
const qdrant = require("./qdrant.cjs");
const { cosine } = require("./cosine.cjs");

let db = null;

function init(database) {
  db = database;
  applyTuning();
}

function applyTuning() {
  const tuning = db?.getConfig?.().voiceTuning || {};
  speakers.setTuning(tuning);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function recommendedCampplusFloor(embeddings) {
  if (!Array.isArray(embeddings) || embeddings.length < 2) return null;
  const centroid = embeddings[embeddings.length - 1];
  const samples = embeddings.slice(0, -1);
  if (!Array.isArray(centroid) || samples.length === 0) return null;
  const sims = samples
    .map((sample) => cosine(sample, centroid))
    .filter((score) => Number.isFinite(score) && score > 0);
  if (sims.length === 0) return null;
  const avg = sims.reduce((sum, score) => sum + score, 0) / sims.length;
  return clamp(avg - 0.24, 0.22, 0.48);
}

function toPcmBuffer(pcm) {
  if (!pcm) return null;
  if (Buffer.isBuffer(pcm)) return Buffer.from(pcm);
  if (pcm instanceof ArrayBuffer) return Buffer.from(pcm);
  if (ArrayBuffer.isView(pcm)) {
    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  if (Array.isArray(pcm)) return Buffer.from(pcm);
  if (pcm.type === "Buffer" && pcm.data) {
    if (Buffer.isBuffer(pcm.data)) return Buffer.from(pcm.data);
    if (Array.isArray(pcm.data)) return Buffer.from(pcm.data);
    if (ArrayBuffer.isView(pcm.data)) {
      return Buffer.from(
        pcm.data.buffer,
        pcm.data.byteOffset,
        pcm.data.byteLength
      );
    }
  }
  if (typeof pcm === "object" && typeof pcm.length === "number") {
    try {
      return Buffer.from(Uint8Array.from(pcm));
    } catch {
      return null;
    }
  }
  try {
    return Buffer.from(pcm);
  } catch {
    return null;
  }
}

async function listVoices() {
  const listed = await qdrant.listVoices();
  if (!listed.ok) return [];
  return listed.voices;
}

async function deleteVoice(id) {
  const deleted = await qdrant.deleteVoice(id);
  if (deleted.ok && deleted.deleted) {
    const listed = await qdrant.listVoices();
    if (listed.ok && (listed.voices || []).length === 0) {
      const current = db?.getConfig?.().voiceTuning || {};
      if (typeof current.campplusEnrolled === "number") {
        db.setConfig({ voiceTuning: { ...current, campplusEnrolled: null } });
        applyTuning();
      }
    }
  }
  return Boolean(deleted.ok && deleted.deleted);
}

async function enrollVoice(payload) {
  const name = String(payload?.name || "").trim();
  const pcm = toPcmBuffer(payload?.pcm);
  if (!name) return { ok: false, error: "Name is required" };
  if (!pcm) return { ok: false, error: "No voice sample received" };
  const reachable = await qdrant.check();
  if (!reachable.ok) {
    return {
      ok: false,
      error: reachable.error || "Start Qdrant locally (http://127.0.0.1:6333)",
    };
  }
  const embedded = await speakers.embedPcm(
    pcm,
    payload?.sampleRate || 16000,
    true
  );
  if (!embedded.ok) return embedded;
  if (embedded.backend && embedded.backend !== "campplus") {
    return {
      ok: false,
      error: "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank",
    };
  }
  const saved = await qdrant.upsertVoices({
    name,
    embeddings: embedded.embeddings || [embedded.embedding],
    backend: embedded.backend,
  });
  if (!saved.ok) return saved;
  if (embedded.backend === "campplus") {
    const floor = recommendedCampplusFloor(embedded.embeddings || []);
    if (typeof floor === "number") {
      const current = db.getConfig().voiceTuning || {};
      db.setConfig({
        voiceTuning: {
          ...current,
          campplusEnrolled: floor,
          updatedAt: new Date().toISOString(),
        },
      });
      applyTuning();
    }
  }
  return saved;
}

async function identifySpeaker(payload) {
  const pcm = toPcmBuffer(payload?.pcm);
  if (!pcm) return { ok: false, error: "No audio" };
  applyTuning();
  return speakers.identifyPcm(pcm, payload?.sampleRate || 16000, false);
}

module.exports = {
  init,
  applyTuning,
  listVoices,
  deleteVoice,
  enrollVoice,
  identifySpeaker,
  resetSession: () => speakers.resetSession(),
};
