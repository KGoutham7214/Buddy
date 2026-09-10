#!/usr/bin/env python3
"""Transcribe an audio file with faster-whisper. Prints JSON to stdout."""

import argparse
import json
import sys


def _configure_stdio() -> None:
    # Avoid Windows cp1252 / charmap crashes on non-ASCII transcript text.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


def _write_utf8(text: str, *, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    data = (text + "\n").encode("utf-8", errors="replace")
    try:
        stream.buffer.write(data)
        stream.buffer.flush()
    except Exception:  # noqa: BLE001
        stream.write(text + "\n")
        stream.flush()


def _pick_device_compute() -> tuple[str, str]:
    try:
        import ctranslate2  # type: ignore

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:  # noqa: BLE001
        pass
    return "cpu", "int8"


def main() -> int:
    _configure_stdio()

    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="en")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--no-vad", action="store_true")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        _write_utf8(
            "faster-whisper is not installed. Run: pip install faster-whisper",
            error=True,
        )
        return 1

    model_name = (args.model or "small").strip() or "small"
    language = (args.language or "").strip() or None
    initial_prompt = (args.initial_prompt or "").strip() or None
    device, compute_type = _pick_device_compute()

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        kwargs = {
            "beam_size": 5,
            "vad_filter": not args.no_vad,
        }
        if language:
            kwargs["language"] = language
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt
        segments, _info = model.transcribe(args.audio, **kwargs)
        parts = []
        timed = []
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            parts.append(text)
            timed.append(
                {
                    "start": float(seg.start or 0),
                    "end": float(seg.end or 0),
                    "text": text,
                }
            )
        payload = {
            "text": " ".join(parts).strip(),
            "segments": timed,
            "model": model_name,
            "device": device,
            "computeType": compute_type,
        }
        _write_utf8(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        # CUDA load can fail even when device count looked positive.
        if device != "cpu":
            try:
                model = WhisperModel(model_name, device="cpu", compute_type="int8")
                kwargs = {
                    "beam_size": 5,
                    "vad_filter": not args.no_vad,
                }
                if language:
                    kwargs["language"] = language
                if initial_prompt:
                    kwargs["initial_prompt"] = initial_prompt
                segments, _info = model.transcribe(args.audio, **kwargs)
                parts = []
                timed = []
                for seg in segments:
                    text = (seg.text or "").strip()
                    if not text:
                        continue
                    parts.append(text)
                    timed.append(
                        {
                            "start": float(seg.start or 0),
                            "end": float(seg.end or 0),
                            "text": text,
                        }
                    )
                payload = {
                    "text": " ".join(parts).strip(),
                    "segments": timed,
                    "model": model_name,
                    "device": "cpu",
                    "computeType": "int8",
                }
                _write_utf8(json.dumps(payload, ensure_ascii=False))
                return 0
            except Exception as fallback_exc:  # noqa: BLE001
                _write_utf8(str(fallback_exc), error=True)
                return 1
        _write_utf8(str(exc), error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
