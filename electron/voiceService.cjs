const speakers = require("./speakers.cjs");
const qdrant = require("./qdrant.cjs");
const { cosine } = require("./cosine.cjs");

let db = null;

const ONNX_BACKENDS = new Set(["campplus", "eres2net"]);

function init(database) {
  db = database;
  applyTuning();
  const model = speakerBackendFromDb();
  speakers.setPreferredModel(model);
}

function speakerBackendFromDb() {
  const raw = String(db?.getConfig?.().speakerBackend || "campplus")
    .trim()
    .toLowerCase();
  return ONNX_BACKENDS.has(raw) ? raw : "campplus";
}

function applyTuning() {
  const tuning = db?.getConfig?.().voiceTuning || {};
  // Phase-3 floors (0.48+) rejected almost every live match — soften once.
  const next = { ...tuning };
  let changed = false;
  for (const key of ["campplusEnrolled", "eres2netEnrolled"]) {
    if (typeof tuning[key] === "number" && tuning[key] > 0.42) {
      next[key] = 0.34;
      changed = true;
    }
  }
  if (changed) {
    next.updatedAt = new Date().toISOString();
    db.setConfig({ voiceTuning: next });
    speakers.setTuning(next);
    return;
  }
  speakers.setTuning(tuning);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function recommendedFloor(embeddings) {
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
      const next = { ...current };
      let changed = false;
      for (const key of ["campplusEnrolled", "eres2netEnrolled"]) {
        if (typeof current[key] === "number") {
          next[key] = null;
          changed = true;
        }
      }
      if (changed) {
        db.setConfig({ voiceTuning: next });
        applyTuning();
      }
    }
  }
  return Boolean(deleted.ok && deleted.deleted);
}

async function clearVoices() {
  const cleared = await qdrant.clearAllVoices();
  if (!cleared.ok) return cleared;
  try {
    db?.clearVoices?.();
  } catch {
    // ignore legacy json voices
  }
  const current = db?.getConfig?.().voiceTuning || {};
  db?.setConfig?.({
    voiceTuning: {
      ...current,
      campplusEnrolled: null,
      eres2netEnrolled: null,
      updatedAt: new Date().toISOString(),
    },
  });
  applyTuning();
  speakers.resetSession();
  return { ok: true, deleted: cleared.deleted || 0 };
}

async function getSpeakerSettings() {
  const backend = speakerBackendFromDb();
  speakers.setPreferredModel(backend);
  const checked = await speakers.check();
  return {
    ok: true,
    speakerBackend: backend,
    backends: ["campplus", "eres2net"],
    speakers: checked,
  };
}

async function setSpeakerBackend(value) {
  const next = ONNX_BACKENDS.has(String(value || "").trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : "campplus";
  const prev = speakerBackendFromDb();
  db.setConfig({ speakerBackend: next });
  speakers.setPreferredModel(next);
  const loaded = await speakers.setModel(next);
  if (!loaded.ok) return loaded;
  if (prev !== next) {
    await clearVoices();
  }
  return {
    ok: true,
    speakerBackend: next,
    cleared: prev !== next,
    backend: loaded.backend,
  };
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

  speakers.setPreferredModel(speakerBackendFromDb());

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
  const deviceLabel = String(payload?.deviceLabel || "").trim();
  const channel = String(payload?.channel || "mic").trim() || "mic";
  const collected = [];
  let backend = "";
  for (const pcm of passBuffers) {
    const embedded = await speakers.embedPcm(pcm, sampleRate, true);
    if (!embedded.ok) return embedded;
    if (embedded.backend && !ONNX_BACKENDS.has(embedded.backend)) {
      return {
        ok: false,
        error:
          "Voice ID needs CampPlus or ERes2Net. Run: pip install onnxruntime kaldi-native-fbank",
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

  // Rebuild centroid as last vector for floor / upsert convention
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
    deviceLabel,
    channel,
  });
  if (!saved.ok) return saved;
  if (ONNX_BACKENDS.has(backend)) {
    const floor = recommendedFloor(embeddings);
    if (typeof floor === "number") {
      const current = db.getConfig().voiceTuning || {};
      const floorKey =
        backend === "eres2net" ? "eres2netEnrolled" : "campplusEnrolled";
      db.setConfig({
        voiceTuning: {
          ...current,
          [floorKey]: floor,
          updatedAt: new Date().toISOString(),
        },
      });
      applyTuning();
    }
  }
  return saved;
}

async function nameSpeakerFromClip(payload) {
  const name = String(payload?.name || "").trim();
  const fromLabel = String(payload?.fromLabel || "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  const enrolled = await enrollVoice({
    name,
    pcm: payload?.pcm,
    passes: payload?.passes,
    sampleRate: payload?.sampleRate || 16000,
    deviceLabel: payload?.deviceLabel || "",
    channel: payload?.channel || "mic",
  });
  if (!enrolled.ok) return enrolled;

  let note = null;
  const noteId = payload?.noteId;
  if (noteId && fromLabel) {
    const existing = db.getNote(noteId);
    if (existing && existing.kind === "meeting") {
      const esc = fromLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\[${esc}\\]`, "g");
      const nextBody = String(existing.body || "").replace(re, `[${name}]`);
      const nextTranscript = String(existing.transcript || "").replace(
        re,
        `[${name}]`
      );
      note = db.updateNote(noteId, {
        body: nextBody,
        transcript: nextTranscript,
      });
    }
  }
  return { ok: true, voice: enrolled.voice, note };
}

async function identifySpeaker(payload) {
  const pcm = toPcmBuffer(payload?.pcm);
  if (!pcm) return { ok: false, error: "No audio" };
  applyTuning();
  speakers.setPreferredModel(speakerBackendFromDb());
  return speakers.identifyPcm(
    pcm,
    payload?.sampleRate || 16000,
    false,
    payload?.channel || "mic"
  );
}

module.exports = {
  init,
  applyTuning,
  listVoices,
  deleteVoice,
  clearVoices,
  enrollVoice,
  nameSpeakerFromClip,
  identifySpeaker,
  getSpeakerSettings,
  setSpeakerBackend,
  resetSession: () => speakers.resetSession(),
};
