#!/usr/bin/env python3
"""JSON-line speaker embedding sidecar for Buddy.

Commands on stdin (one JSON object per line):
  {"id": 1, "cmd": "status"}
  {"id": 2, "cmd": "embed", "pcm_b64": "...", "sample_rate": 16000, "enroll": false}
  {"id": 3, "cmd": "embed_segments", "audio": "path", "segments": [...]}
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
from typing import Any

MODEL_NAME = "campplus_voxceleb_16k.onnx"
MODEL_URLS = [
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
]


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


def _write(obj: dict[str, Any]) -> None:
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8", errors="replace")
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except Exception:  # noqa: BLE001
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def detect_backend() -> str | None:
    try:
        import kaldi_native_fbank  # noqa: F401
        import onnxruntime  # noqa: F401

        return "campplus"
    except Exception:  # noqa: BLE001
        return None


_encoder = None
_backend: str | None = None
_cache_dir = ""


def model_path() -> str:
    return os.path.join(_cache_dir or ".", MODEL_NAME)


def ensure_campplus_model() -> str:
    path = model_path()
    if os.path.isfile(path) and os.path.getsize(path) > 1_000_000:
        return path
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    last_error = "download failed"
    for url in MODEL_URLS:
        try:
            urllib.request.urlretrieve(url, path)
            if os.path.isfile(path) and os.path.getsize(path) > 1_000_000:
                return path
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
    raise RuntimeError(f"Could not download speaker model: {last_error}")


def load_encoder() -> str:
    global _encoder, _backend
    if _encoder is not None and _backend:
        return _backend

    backend = detect_backend()
    if backend == "campplus":
        import onnxruntime as ort

        path = ensure_campplus_model()
        _encoder = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        _backend = "campplus"
        return _backend

    raise RuntimeError(
        "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank"
    )


def _mel_filterbank(n_mels: int, freqs):
    import numpy as np

    def hz_to_mel(hz):
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel):
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    low = hz_to_mel(0.0)
    high = hz_to_mel(float(freqs[-1]))
    points = np.linspace(low, high, n_mels + 2)
    hz_points = mel_to_hz(points)
    bins = np.searchsorted(freqs, hz_points)
    fb = np.zeros((n_mels, len(freqs)), dtype=np.float32)
    for i in range(n_mels):
        left, center, right = bins[i], bins[i + 1], bins[i + 2]
        if center > left:
            fb[i, left:center] = (np.arange(left, center) - left) / max(
                1, center - left
            )
        if right > center:
            fb[i, center:right] = (right - np.arange(center, right)) / max(
                1, right - center
            )
    return fb


def basic_embed(wav, sr: int = 16000) -> list[float]:
    import numpy as np

    x = np.append(wav[0], wav[1:] - 0.97 * wav[:-1]).astype(np.float32)
    frame = int(0.025 * sr)
    hop = int(0.010 * sr)
    if x.shape[0] < frame:
        x = np.pad(x, (0, frame - x.shape[0]))
    window = np.hanning(frame).astype(np.float32)
    n_fft = 512
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    mels = _mel_filterbank(40, freqs)
    specs = []
    for start in range(0, x.shape[0] - frame + 1, hop):
        chunk = x[start : start + frame] * window
        if float(np.sqrt(np.mean(chunk * chunk))) < 0.01:
            continue
        mag = np.abs(np.fft.rfft(chunk, n_fft))
        specs.append(np.log(np.dot(mels, mag) + 1e-6))
    if not specs:
        specs = [np.zeros(40, dtype=np.float32)]
    mat = np.stack(specs, axis=0)
    feat = np.concatenate([mat.mean(axis=0), mat.std(axis=0)])
    return _l2(feat)


def campplus_fbank(wav, sr: int = 16000):
    import kaldi_native_fbank as knf
    import numpy as np

    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = sr
    opts.frame_opts.dither = 0
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = 80
    fbank = knf.OnlineFbank(opts)
    fbank.accept_waveform(sr, wav.astype(np.float32).tolist())
    fbank.input_finished()
    frames = [fbank.get_frame(i) for i in range(fbank.num_frames_ready)]
    if not frames:
        raise RuntimeError("no fbank frames")
    feat = np.stack(frames).astype(np.float32)
    feat -= feat.mean(axis=0, keepdims=True)
    return feat


def _l2(vec) -> list[float]:
    import numpy as np

    arr = np.asarray(vec, dtype=np.float64).ravel()
    norm = float(np.linalg.norm(arr))
    if norm > 0:
        arr = arr / norm
    return [float(x) for x in arr]


def rms(wav) -> float:
    import numpy as np

    if wav.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(wav))))


def _cosine(a, b) -> float:
    import numpy as np

    x = np.asarray(a, dtype=np.float64).ravel()
    y = np.asarray(b, dtype=np.float64).ravel()
    denom = float(np.linalg.norm(x) * np.linalg.norm(y))
    if denom <= 0:
        return -1.0
    return float(np.dot(x, y) / denom)


def _as_16k_float(pcm_b64: str, sample_rate: int):
    import numpy as np

    raw = base64.b64decode(pcm_b64)
    wav = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if sample_rate and sample_rate != 16000:
        duration = wav.shape[0] / float(sample_rate)
        target = max(1, int(duration * 16000))
        x_old = np.linspace(0.0, 1.0, num=wav.shape[0], endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
        wav = np.interp(x_new, x_old, wav).astype(np.float32)
    min_len = int(1.2 * 16000)
    if wav.shape[0] < min_len:
        wav = np.pad(wav, (0, min_len - wav.shape[0]))
    return wav


def embed_wav(wav) -> list[float]:
    wav = normalize_rms(wav)
    backend = load_encoder()
    if backend != "campplus":
        raise RuntimeError(
            "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank"
        )
    feat = campplus_fbank(wav)[None, ...]
    inp = _encoder.get_inputs()[0].name
    out = _encoder.run(None, {inp: feat})[0]
    return _l2(out[0])


MIN_ABS_RMS = 0.006
VAD_NOISE_MULT = 3.0
TARGET_EMBED_RMS = 0.1
NOISE_WINDOW_S = 0.3
MIN_ENROLL_WINDOWS = 1
MAX_ENROLL_WINDOWS = 8
ENROLL_OUTLIER_COS = 0.42


def noise_floor(wav, sr: int = 16000) -> float:
    import numpy as np

    hop = max(1, int(0.02 * sr))
    limit = min(wav.shape[0], int(NOISE_WINDOW_S * sr))
    if limit < hop:
        return max(MIN_ABS_RMS, rms(wav))
    floors = []
    for start in range(0, limit - hop + 1, hop):
        floors.append(rms(wav[start : start + hop]))
    if not floors:
        return max(MIN_ABS_RMS, rms(wav[:limit]))
    floors.sort()
    quiet = floors[len(floors) // 5]
    return max(MIN_ABS_RMS, float(quiet))


def speech_threshold(noise: float) -> float:
    return max(MIN_ABS_RMS, noise * VAD_NOISE_MULT)


def normalize_rms(wav):
    import numpy as np

    arr = np.asarray(wav, dtype=np.float32)
    level = rms(arr)
    if level < 1e-8:
        return arr
    scaled = arr * (TARGET_EMBED_RMS / level)
    peak = float(np.max(np.abs(scaled)))
    if peak > 0.99:
        scaled = scaled * (0.99 / peak)
    return scaled.astype(np.float32)


def voiced_windows(wav, sr: int = 16000, win: float = 2.0, hop: float = 0.75):
    win_n = int(win * sr)
    hop_n = int(hop * sr)
    threshold = speech_threshold(noise_floor(wav, sr))
    if wav.shape[0] <= win_n:
        if rms(wav) >= threshold:
            yield wav
        return
    for start in range(0, wav.shape[0] - win_n + 1, hop_n):
        clip = wav[start : start + win_n]
        if rms(clip) >= threshold:
            yield clip


def embed_enroll(wav) -> tuple[list[list[float]] | None, int]:
    import numpy as np

    raw = [np.asarray(embed_wav(clip), dtype=np.float64) for clip in voiced_windows(wav)]
    if not raw and rms(wav) >= speech_threshold(noise_floor(wav)):
        raw = [np.asarray(embed_wav(wav), dtype=np.float64)]
    windows = len(raw)
    if windows < MIN_ENROLL_WINDOWS:
        return None, windows
    if windows >= 3:
        avg = np.mean(np.stack(raw), axis=0)
        kept = [vec for vec in raw if _cosine(vec, avg) >= ENROLL_OUTLIER_COS]
        if len(kept) >= 2:
            raw = kept
            windows = len(raw)
    if windows > MAX_ENROLL_WINDOWS:
        idx = np.linspace(0, windows - 1, MAX_ENROLL_WINDOWS).astype(int)
        raw = [raw[int(i)] for i in idx]
        windows = len(raw)
    avg = _l2(np.mean(np.stack(raw), axis=0))
    embeddings = [_l2(vec) for vec in raw]
    embeddings.append(avg)
    return embeddings, windows


def embed_live(wav) -> tuple[list[list[float]] | None, bool]:
    import numpy as np

    # Average several voiced windows so matching is the voice, not the words.
    clips = list(voiced_windows(wav, win=2.0, hop=0.5))
    if not clips:
        if rms(wav) >= speech_threshold(noise_floor(wav)):
            return [embed_wav(wav)], True
        return None, False
    clips.sort(key=rms, reverse=True)
    raw = [np.asarray(embed_wav(clip), dtype=np.float64) for clip in clips[:6]]
    return [_l2(np.mean(np.stack(raw), axis=0))], True


def decode_audio_file(path: str):
    try:
        from faster_whisper.audio import decode_audio

        return decode_audio(path, sampling_rate=16000)
    except Exception:  # noqa: BLE001
        pass
    try:
        import numpy as np
        from scipy.io import wavfile

        sr, data = wavfile.read(path)
        if data.ndim > 1:
            data = data.mean(axis=1)
        wav = data.astype("float32")
        if wav.max() > 1.5:
            wav = wav / 32768.0
        if sr != 16000:
            duration = wav.shape[0] / float(sr)
            target = max(1, int(duration * 16000))
            x_old = np.linspace(0.0, 1.0, num=wav.shape[0], endpoint=False)
            x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
            wav = np.interp(x_new, x_old, wav).astype("float32")
        return wav
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Could not decode audio: {exc}") from exc


def handle(msg: dict[str, Any]) -> dict[str, Any]:
    cmd = msg.get("cmd")
    req_id = msg.get("id")

    if cmd == "status":
        backend = detect_backend()
        if not backend:
            return {
                "id": req_id,
                "ok": False,
                "backend": None,
                "ready": False,
                "error": "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank",
            }
        try:
            load_encoder()
        except Exception as exc:  # noqa: BLE001
            return {
                "id": req_id,
                "ok": False,
                "backend": backend,
                "ready": False,
                "error": str(exc),
            }
        return {
            "id": req_id,
            "ok": True,
            "backend": backend,
            "ready": True,
            "error": None,
        }

    if cmd == "self_test":
        import numpy as np

        sr = 16000
        rng = np.random.default_rng(1)
        t = np.linspace(0, 2.0, sr * 2, endpoint=False)
        a = (
            0.12 * np.sin(2 * np.pi * 140 * t)
            + 0.04 * rng.normal(0, 1, t.shape)
        ).astype(np.float32)
        b = (
            0.12 * np.sin(2 * np.pi * 90 * t)
            + 0.04 * rng.normal(0, 1, t.shape)
        ).astype(np.float32)
        ea = np.asarray(embed_wav(a))
        ea2 = np.asarray(embed_wav(a))
        eb = np.asarray(embed_wav(b))
        same = float(np.dot(ea, ea2))
        diff = float(np.dot(ea, eb))
        ok = same > 0.9
        return {
            "id": req_id,
            "ok": ok,
            "backend": _backend,
            "same": same,
            "diff": diff,
            "error": None if ok else "Self-test failed",
        }

    if cmd == "embed":
        wav = _as_16k_float(
            str(msg.get("pcm_b64") or ""), int(msg.get("sample_rate") or 16000)
        )
        load_encoder()
        if msg.get("enroll"):
            embeddings, windows = embed_enroll(wav)
            if not embeddings:
                return {
                    "id": req_id,
                    "ok": False,
                    "backend": _backend,
                    "windows": windows,
                    "speech": False,
                    "error": "Didn't hear enough speech — try again closer to the mic.",
                }
            return {
                "id": req_id,
                "ok": True,
                "backend": _backend,
                "embedding": embeddings[-1],
                "embeddings": embeddings,
                "windows": windows,
                "speech": True,
            }
        embeddings, speech = embed_live(wav)
        if not speech or not embeddings:
            return {
                "id": req_id,
                "ok": True,
                "backend": _backend,
                "speech": False,
                "embedding": None,
                "embeddings": [],
            }
        return {
            "id": req_id,
            "ok": True,
            "backend": _backend,
            "embedding": embeddings[0],
            "embeddings": embeddings,
            "speech": True,
        }

    if cmd == "embed_segments":
        audio = str(msg.get("audio") or "")
        segments = msg.get("segments") or []
        wav = decode_audio_file(audio)
        sr = 16000
        embeddings: list[list[float] | None] = []
        for seg in segments:
            start = int(max(0.0, float(seg.get("start") or 0)) * sr)
            end = int(max(start + 1, float(seg.get("end") or 0) * sr))
            clip = wav[start : min(end, len(wav))]
            if clip.shape[0] < int(0.8 * sr) or rms(clip) < speech_threshold(
                noise_floor(clip, sr)
            ):
                embeddings.append(None)
                continue
            embeddings.append(embed_wav(clip))
        return {
            "id": req_id,
            "ok": True,
            "backend": _backend,
            "embeddings": embeddings,
        }

    return {"id": req_id, "ok": False, "error": f"Unknown cmd: {cmd}"}


def main() -> int:
    global _cache_dir
    _configure_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default="")
    args = parser.parse_args()
    _cache_dir = args.cache_dir or ""

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _write({"ok": False, "error": "Invalid JSON"})
            continue
        try:
            _write(handle(msg))
        except Exception as exc:  # noqa: BLE001
            _write({"id": msg.get("id"), "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
