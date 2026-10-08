#!/usr/bin/env python3
"""faster-whisper sidecar for Buddy.

JSON-line mode (default when no audio path):
  {"id": 1, "cmd": "status"}
  {"id": 2, "cmd": "warm", "model": "distil-small.en"}
  {"id": 3, "cmd": "transcribe", "audio": "path", "model": "...", "language": "en",
   "initial_prompt": "...", "beam_size": 1, "vad_filter": true}

One-shot CLI (compat):
  python transcribe.py audio.wav --model distil-small.en --beam-size 1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from typing import Any

# Production-grade only — tiny/base variants transcribe too poorly for meetings.
ALLOWED_MODELS = {
    "small",
    "small.en",
    "medium",
    "medium.en",
    "distil-small.en",
    "distil-medium.en",
}

DEFAULT_MODEL = "distil-small.en"
DEFAULT_BEAM = 1

_model = None
_model_name: str | None = None
_device = "cpu"
_compute_type = "int8"


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


def _write(obj: dict[str, Any]) -> None:
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode(
        "utf-8", errors="replace"
    )
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except Exception:  # noqa: BLE001
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def _write_utf8(text: str, *, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    data = (text + "\n").encode("utf-8", errors="replace")
    try:
        stream.buffer.write(data)
        stream.buffer.flush()
    except Exception:  # noqa: BLE001
        stream.write(text + "\n")
        stream.flush()


def normalize_model(value: str | None) -> str:
    key = str(value or DEFAULT_MODEL).strip().lower()
    return key if key in ALLOWED_MODELS else DEFAULT_MODEL


def clamp_beam(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = DEFAULT_BEAM
    return max(1, min(5, n))


def pick_device_compute() -> tuple[str, str]:
    try:
        import ctranslate2  # type: ignore

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:  # noqa: BLE001
        pass
    return "cpu", "int8"


def load_model(model_name: str | None = None):
    global _model, _model_name, _device, _compute_type
    from faster_whisper import WhisperModel

    name = normalize_model(model_name)
    if _model is not None and _model_name == name:
        return _model, name, _device, _compute_type

    device, compute_type = pick_device_compute()
    try:
        loaded = WhisperModel(name, device=device, compute_type=compute_type)
    except Exception:
        if device != "cpu":
            device, compute_type = "cpu", "int8"
            loaded = WhisperModel(name, device=device, compute_type=compute_type)
        else:
            raise
    _model = loaded
    _model_name = name
    _device = device
    _compute_type = compute_type
    return _model, name, _device, _compute_type


def _pcm_wav_for_whisper(audio: str) -> tuple[str, str | None]:
    """Decode WebM/Opus to a 16 kHz wav so Whisper does not skip the opening."""
    ext = os.path.splitext(audio)[1].lower()
    if ext in {".wav", ".flac"}:
        return audio, None
    try:
        import numpy as np
        from faster_whisper.audio import decode_audio
    except Exception:  # noqa: BLE001
        return audio, None
    samples = decode_audio(audio, sampling_rate=16000)
    pcm = np.clip(np.asarray(samples) * 32767.0, -32768, 32767).astype(np.int16)
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    import wave

    with wave.open(tmp, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(pcm.tobytes())
    return tmp, tmp


def run_transcribe(
    audio: str,
    *,
    model_name: str | None = None,
    language: str | None = "en",
    initial_prompt: str | None = None,
    beam_size: int = DEFAULT_BEAM,
    vad_filter: bool = True,
) -> dict[str, Any]:
    wav_path, tmp_wav = _pcm_wav_for_whisper(audio)
    try:
        return _run_transcribe_file(
            wav_path,
            model_name=model_name,
            language=language,
            initial_prompt=initial_prompt,
            beam_size=beam_size,
            vad_filter=vad_filter,
        )
    finally:
        if tmp_wav:
            try:
                os.remove(tmp_wav)
            except OSError:
                pass


def _run_transcribe_file(
    audio: str,
    *,
    model_name: str | None = None,
    language: str | None = None,
    initial_prompt: str | None = None,
    beam_size: int = DEFAULT_BEAM,
    vad_filter: bool = True,
) -> dict[str, Any]:
    model, name, device, compute_type = load_model(model_name)
    lang = (language or "").strip() or None
    # Distil / .en models are English-only — force en.
    if name.endswith(".en") or name.startswith("distil-"):
        lang = "en"
    prompt = (initial_prompt or "").strip() or None
    kwargs: dict[str, Any] = {
        "beam_size": clamp_beam(beam_size),
        "vad_filter": bool(vad_filter),
        "word_timestamps": True,
        # Never feed earlier output back in as context: on CPU with small
        # models one bad segment otherwise derails the rest of the meeting
        # into repetition loops.
        "condition_on_previous_text": False,
    }
    if vad_filter:
        # Defaults are tuned for clean single-voice audio and drop quiet or
        # far-field speech (system-audio participants). Keep the filter for
        # hallucination control but make it much less aggressive.
        kwargs["vad_parameters"] = {
            "threshold": 0.3,
            "min_silence_duration_ms": 1500,
            "speech_pad_ms": 500,
        }
    if lang:
        kwargs["language"] = lang
    if prompt:
        kwargs["initial_prompt"] = prompt

    segments_iter, _info = model.transcribe(audio, **kwargs)
    parts: list[str] = []
    timed: list[dict[str, Any]] = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if not text:
            continue
        parts.append(text)
        words = []
        for word in getattr(seg, "words", None) or []:
            token = str(getattr(word, "word", "") or "").strip()
            if not token:
                continue
            words.append(
                {
                    "text": token,
                    "start": float(getattr(word, "start", None) or seg.start or 0),
                    "end": float(getattr(word, "end", None) or seg.end or 0),
                }
            )
        timed.append(
            {
                "start": float(seg.start or 0),
                "end": float(seg.end or 0),
                "text": text,
                "words": words,
            }
        )
    return {
        "ok": True,
        "text": " ".join(parts).strip(),
        "segments": timed,
        "model": name,
        "device": device,
        "computeType": compute_type,
        "beamSize": clamp_beam(beam_size),
    }


def handle(msg: dict[str, Any]) -> dict[str, Any]:
    req_id = msg.get("id")
    cmd = str(msg.get("cmd") or "").strip()

    if cmd == "status":
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return {
                "id": req_id,
                "ok": False,
                "ready": False,
                "models": sorted(ALLOWED_MODELS),
                "error": "faster-whisper is not installed. Run: pip install faster-whisper",
            }
        device, compute_type = pick_device_compute()
        return {
            "id": req_id,
            "ok": True,
            "ready": True,
            "warm": _model is not None,
            "model": _model_name,
            "device": device if _model is None else _device,
            "computeType": compute_type if _model is None else _compute_type,
            "models": sorted(ALLOWED_MODELS),
            "defaultModel": DEFAULT_MODEL,
            "defaultBeam": DEFAULT_BEAM,
            "error": None,
        }

    if cmd == "warm":
        try:
            _, name, device, compute_type = load_model(str(msg.get("model") or ""))
        except Exception as exc:  # noqa: BLE001
            return {"id": req_id, "ok": False, "error": str(exc)}
        return {
            "id": req_id,
            "ok": True,
            "model": name,
            "device": device,
            "computeType": compute_type,
        }

    if cmd == "transcribe":
        audio = str(msg.get("audio") or "").strip()
        if not audio:
            return {"id": req_id, "ok": False, "error": "Missing audio path"}
        try:
            result = run_transcribe(
                audio,
                model_name=str(msg.get("model") or ""),
                language=str(msg.get("language") or "en"),
                initial_prompt=str(msg.get("initial_prompt") or ""),
                beam_size=msg.get("beam_size", DEFAULT_BEAM),
                vad_filter=msg.get("vad_filter", True) is not False,
            )
        except Exception as exc:  # noqa: BLE001
            return {"id": req_id, "ok": False, "error": str(exc)}
        if not result.get("text"):
            return {
                "id": req_id,
                "ok": False,
                "error": "Empty transcript",
                "segments": result.get("segments") or [],
                "model": result.get("model"),
            }
        return {"id": req_id, **result}

    return {"id": req_id, "ok": False, "error": f"Unknown cmd: {cmd}"}


def run_sidecar() -> int:
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
            _write(handle(msg if isinstance(msg, dict) else {}))
        except Exception as exc:  # noqa: BLE001
            _write({"id": msg.get("id") if isinstance(msg, dict) else None, "ok": False, "error": str(exc)})
    return 0


def run_oneshot(args: argparse.Namespace) -> int:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        _write_utf8(
            "faster-whisper is not installed. Run: pip install faster-whisper",
            error=True,
        )
        return 1
    try:
        result = run_transcribe(
            args.audio,
            model_name=args.model,
            language=args.language,
            initial_prompt=args.initial_prompt,
            beam_size=args.beam_size,
            vad_filter=not args.no_vad,
        )
    except Exception as exc:  # noqa: BLE001
        _write_utf8(str(exc), error=True)
        return 1
    if not result.get("text"):
        _write_utf8("Empty transcript", error=True)
        return 1
    _write_utf8(json.dumps(result, ensure_ascii=False))
    return 0


def main() -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="?", default="")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default="en")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--beam-size", type=int, default=DEFAULT_BEAM)
    parser.add_argument("--no-vad", action="store_true")
    parser.add_argument(
        "--sidecar",
        action="store_true",
        help="Force JSON-line sidecar mode (also default when no audio path)",
    )
    args = parser.parse_args()

    if args.sidecar or not str(args.audio or "").strip():
        return run_sidecar()
    return run_oneshot(args)


if __name__ == "__main__":
    raise SystemExit(main())
