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
  // Phase-3 floors (0.48+) rejected almost every live match — soften once.
  if (
    typeof tuning.campplusEnrolled === "number" &&
    tuning.campplusEnrolled > 0.42
  ) {
    const next = {
      ...tuning,
      campplusEnrolled: 0.34,
      updatedAt: new Date().toISOString(),
    };
    db.setConfig({ voiceTuning: next });
    speakers.setTuning(next);
    return;
  }
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
  // Leave headroom under typical live scores (often 0.32–0.45 on headset).
  return clamp(avg - 0.18, 0.28, 0.42);
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
  if (!name) return { ok: false, error: "Name is required" };
  const reachable = await qdrant.check();
  if (!reachable.ok) {
    return {
      ok: false,
      error: reachable.error || "Start Qdrant locally (http://127.0.0.1:6333)",
    };
  }

  const passBuffers = [];
  if (Array.isArray(payload?.passes) && payload.passes.length > 0) {
    for (const part of payload.passes) {
      const buf = toPcmBuffer(part);
      if (buf) passBuffers.push(buf);
    }
  } else {
    const pcm = toPcmBuffer(payload?.pcm);
    if (pcm) passBuffers.push(pcm);
  }
  if (passBuffers.length === 0) {
    return { ok: false, error: "No voice sample received" };
  }

  const sampleRate = payload?.sampleRate || 16000;
  const collected = [];
  let backend = "";
  for (const pcm of passBuffers) {
    const embedded = await speakers.embedPcm(pcm, sampleRate, true);
    if (!embedded.ok) return embedded;
    if (embedded.backend && embedded.backend !== "campplus") {
      return {
        ok: false,
        error:
          "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank",
      };
    }
    backend = embedded.backend || backend;
    const vecs = embedded.embeddings || [];
    // embed_enroll appends a per-pass centroid last — keep clip vectors only
    const clips = vecs.length > 1 ? vecs.slice(0, -1) : vecs;
    for (const vec of clips) {
      if (Array.isArray(vec) && vec.length > 0) collected.push(vec);
    }
  }
  if (collected.length < 2) {
    return {
      ok: false,
      error: "Didn't hear enough speech across passes — try again closer to the mic.",
    };
  }

  // Rebuild centroid as last vector for recommendedCampplusFloor / upsert convention
  const dim = collected[0].length;
  const centroid = new Array(dim).fill(0);
  for (const vec of collected) {
    for (let i = 0; i < dim; i++) centroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= collected.length;
  const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0)) || 1;
  const unitCentroid = centroid.map((v) => v / norm);
  const embeddings = [...collected, unitCentroid];

  const saved = await qdrant.upsertVoices({
    name,
    embeddings,
    backend,
  });
  if (!saved.ok) return saved;
  if (backend === "campplus") {
    const floor = recommendedCampplusFloor(embeddings);
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
