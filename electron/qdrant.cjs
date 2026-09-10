const { randomUUID } = require("crypto");
const { cosine } = require("./cosine.cjs");

const COLLECTION = "buddy_voices";

function baseUrl() {
  return String(process.env.BUDDY_QDRANT_URL || "http://127.0.0.1:6333").replace(
    /\/$/,
    ""
  );
}

async function qdrantFetch(pathname, { method = "GET", body, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) {
      const error =
        json?.status?.error || json?.error || res.statusText || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error, json };
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? "Qdrant timed out"
        : err.message || "Qdrant is not running at http://127.0.0.1:6333",
    };
  } finally {
    clearTimeout(timer);
  }
}

function publicVoice(point) {
  const payload = point.payload || {};
  return {
    id: String(point.id),
    name: payload.name || "Voice",
    backend: payload.backend || "",
    createdAt: payload.createdAt || "",
    updatedAt: payload.updatedAt || "",
  };
}

async function check() {
  const res = await qdrantFetch("/");
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || "Start Qdrant locally (http://127.0.0.1:6333)",
    };
  }
  return { ok: true, url: baseUrl() };
}

async function collectionInfo() {
  const res = await qdrantFetch(`/collections/${COLLECTION}`);
  if (!res.ok) {
    if (res.status === 404) return { ok: true, exists: false };
    return { ok: false, error: res.error };
  }
  const params = res.json?.result?.config?.params?.vectors;
  const size = typeof params?.size === "number" ? params.size : null;
  const points = res.json?.result?.points_count ?? 0;
  return { ok: true, exists: true, size, points };
}

async function createCollection(size) {
  const created = await qdrantFetch(`/collections/${COLLECTION}`, {
    method: "PUT",
    body: {
      vectors: { size, distance: "Cosine" },
    },
  });
  if (!created.ok) return created;
  await ensureIndexes();
  return { ok: true, size };
}

async function ensureIndexes() {
  for (const field of ["nameKey", "backend"]) {
    await qdrantFetch(`/collections/${COLLECTION}/index`, {
      method: "PUT",
      body: { field_name: field, field_schema: "keyword" },
    });
  }
}

async function ensureCollection(size) {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) {
    const created = await createCollection(size);
    if (!created.ok) return created;
    return { ok: true, size };
  }
  if (info.size && info.size !== size) {
    return {
      ok: false,
      error: `Qdrant collection expects ${info.size}-d vectors, got ${size}. Re-enroll with the active backend or recreate buddy_voices manually.`,
    };
  }
  await ensureIndexes();
  return { ok: true, size: info.size || size };
}

async function count() {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, points: 0 };
  return { ok: true, points: info.points || 0 };
}

async function findByNameKey(nameKey) {
  const listed = await findAllByNameKey(nameKey);
  if (!listed.ok) return listed;
  return { ok: true, point: listed.points[0] || null };
}

async function findAllByNameKey(nameKey) {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, points: [] };
  const res = await qdrantFetch(`/collections/${COLLECTION}/points/scroll`, {
    method: "POST",
    body: {
      limit: 64,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [{ key: "nameKey", match: { value: nameKey } }],
      },
    },
  });
  if (!res.ok) return res;
  return { ok: true, points: res.json?.result?.points || [] };
}

async function deleteByNameKey(nameKey) {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true };
  const res = await qdrantFetch(`/collections/${COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: {
      filter: {
        must: [{ key: "nameKey", match: { value: nameKey } }],
      },
    },
  });
  if (!res.ok) return res;
  return { ok: true };
}

async function retrievePoint(id) {
  const res = await qdrantFetch(`/collections/${COLLECTION}/points`, {
    method: "POST",
    body: {
      ids: [id],
      with_payload: true,
      with_vector: false,
    },
  });
  if (!res.ok) return res;
  const points = res.json?.result || [];
  return { ok: true, point: points[0] || null };
}

async function upsertVoices({ name, embeddings, backend, createdAt }) {
  const vectors = (Array.isArray(embeddings) ? embeddings : []).filter(
    (vec) => Array.isArray(vec) && vec.length > 0
  );
  if (vectors.length === 0) {
    return { ok: false, error: "Empty embedding" };
  }
  if (backend && backend !== "campplus") {
    return {
      ok: false,
      error: "Voice ID needs CampPlus. Re-enroll after installing onnxruntime and kaldi-native-fbank.",
    };
  }
  const ensured = await ensureCollection(vectors[0].length);
  if (!ensured.ok) return ensured;

  const trimmed = String(name || "").trim() || "Voice";
  const nameKey = trimmed.toLowerCase();
  const existing = await findAllByNameKey(nameKey);
  if (!existing.ok) return existing;

  const now = new Date().toISOString();
  const created = existing.points[0]?.payload?.createdAt || createdAt || now;
  const removed = await deleteByNameKey(nameKey);
  if (!removed.ok) return removed;

  const points = vectors.map((vector, index) => ({
    id: randomUUID(),
    vector,
    payload: {
      name: trimmed,
      nameKey,
      backend: backend || "",
      createdAt: created,
      updatedAt: now,
      kind: index === vectors.length - 1 ? "centroid" : "enroll_clip",
    },
  }));

  const res = await qdrantFetch(`/collections/${COLLECTION}/points?wait=true`, {
    method: "PUT",
    body: { points },
  });
  if (!res.ok) return res;
  return {
    ok: true,
    voice: {
      id: String(points[0].id),
      name: trimmed,
      backend: backend || "",
      createdAt: created,
      updatedAt: now,
    },
  };
}

async function upsertVoice({ id, name, embedding, backend, createdAt }) {
  return upsertVoices({
    name,
    embeddings: [embedding],
    backend,
    createdAt: createdAt || undefined,
    id,
  });
}

async function listVoices() {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, voices: [] };
  const res = await qdrantFetch(`/collections/${COLLECTION}/points/scroll`, {
    method: "POST",
    body: {
      limit: 200,
      with_payload: true,
      with_vector: false,
    },
  });
  if (!res.ok) return res;
  const grouped = new Map();
  for (const point of res.json?.result?.points || []) {
    const payload = point.payload || {};
    const key = String(payload.nameKey || payload.name || point.id).toLowerCase();
    const voice = publicVoice(point);
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, voice);
      continue;
    }
    if (voice.createdAt && (!prev.createdAt || voice.createdAt < prev.createdAt)) {
      prev.createdAt = voice.createdAt;
    }
    if (voice.updatedAt && (!prev.updatedAt || voice.updatedAt > prev.updatedAt)) {
      prev.updatedAt = voice.updatedAt;
      prev.backend = voice.backend || prev.backend;
    }
  }
  const voices = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, voices };
}

async function deleteVoice(id) {
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, deleted: false };
  const retrieved = await retrievePoint(id);
  if (!retrieved.ok) return retrieved;
  const nameKey = retrieved.point?.payload?.nameKey;
  if (nameKey) {
    const removed = await deleteByNameKey(nameKey);
    if (!removed.ok) return removed;
    return { ok: true, deleted: true };
  }
  const res = await qdrantFetch(`/collections/${COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: { points: [id] },
  });
  if (!res.ok) return res;
  return { ok: true, deleted: true };
}

function asVector(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return null;
}

async function search(embedding, { backend, limit = 8 } = {}) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { ok: false, error: "Empty embedding" };
  }
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, hits: [] };

  const body = {
    vector: embedding,
    limit,
    with_payload: true,
  };
  if (backend) {
    body.filter = {
      must: [{ key: "backend", match: { value: backend } }],
    };
  }
  const res = await qdrantFetch(`/collections/${COLLECTION}/points/search`, {
    method: "POST",
    body,
  });
  if (!res.ok) return res;
  const raw = res.json?.result;
  const list = Array.isArray(raw) ? raw : raw?.points || [];
  const hits = list.map((hit) => ({
    id: String(hit.id),
    score: Number(hit.score) || 0,
    payload: hit.payload || {},
  }));
  return { ok: true, hits };
}

async function scoreByCosine(embedding, { backend, limit = 16 } = {}) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { ok: false, error: "Empty embedding" };
  }
  const info = await collectionInfo();
  if (!info.ok) return info;
  if (!info.exists) return { ok: true, hits: [] };

  const res = await qdrantFetch(`/collections/${COLLECTION}/points/scroll`, {
    method: "POST",
    body: {
      limit: 200,
      with_payload: true,
      with_vector: true,
    },
  });
  if (!res.ok) return res;
  const hits = [];
  for (const point of res.json?.result?.points || []) {
    const payload = point.payload || {};
    if (backend && payload.backend && payload.backend !== backend) continue;
    const vector = asVector(point.vector);
    const score = cosine(embedding, vector);
    if (score < 0) continue;
    hits.push({
      id: String(point.id),
      score,
      payload,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { ok: true, hits: hits.slice(0, limit) };
}

async function migrateVoices(voices) {
  const list = Array.isArray(voices) ? voices : [];
  if (list.length === 0) return { ok: true, migrated: 0 };
  const counted = await count();
  if (!counted.ok) return counted;
  if (counted.points > 0) return { ok: true, migrated: 0, skipped: true };

  let migrated = 0;
  for (const voice of list) {
    if (!Array.isArray(voice.embedding) || voice.embedding.length === 0) continue;
    const saved = await upsertVoice({
      id: voice.id,
      name: voice.name,
      embedding: voice.embedding,
      backend: voice.backend,
      createdAt: voice.createdAt,
    });
    if (!saved.ok) return saved;
    migrated += 1;
  }
  return { ok: true, migrated };
}

module.exports = {
  COLLECTION,
  baseUrl,
  check,
  count,
  listVoices,
  upsertVoice,
  upsertVoices,
  deleteVoice,
  search,
  scoreByCosine,
  migrateVoices,
};
