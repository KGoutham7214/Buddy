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


def main() -> int:
    _configure_stdio()

    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="base")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        _write_utf8(
            "faster-whisper is not installed. Run: pip install faster-whisper",
            error=True,
        )
        return 1

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(args.audio, beam_size=5)
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
        payload = {"text": " ".join(parts).strip(), "segments": timed}
        _write_utf8(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        _write_utf8(str(exc), error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
