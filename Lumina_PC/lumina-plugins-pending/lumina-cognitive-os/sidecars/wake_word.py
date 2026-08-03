"""
wake_word.py — Continuous wake-word detector for Lumina.

Streams microphone audio through openwakeword and prints one JSON line
to stdout per detection:
    {"kind":"detected","model":"hey_jarvis_v0.1","score":0.87,"atISO":"..."}

The TS side spawns this with `--once` for a quick test, or without
`--once` for the always-on daemon mode.

Requirements:
    pip install openwakeword sounddevice numpy

Usage:
    python wake_word.py [--model NAME] [--threshold 0.5] [--once]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone

CHUNK_MS = 80
SAMPLE_RATE = 16_000


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="hey_jarvis_v0.1")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--once", action="store_true",
                   help="Print the first detection and exit.")
    args = p.parse_args()

    try:
        import numpy as np
        import sounddevice as sd
        from openwakeword.model import Model  # type: ignore
    except ImportError as e:
        emit({"ok": False, "error": f"missing dependency: {e!s}. pip install openwakeword sounddevice numpy"})
        sys.exit(2)

    try:
        oww = Model(wakeword_models=[args.model])
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"failed to load model '{args.model}': {e!s}"})
        sys.exit(2)

    chunk_samples = int(SAMPLE_RATE * CHUNK_MS / 1000)
    last_emit = 0.0

    emit({"ok": True, "kind": "listening", "model": args.model, "threshold": args.threshold})

    try:
        with sd.InputStream(channels=1, samplerate=SAMPLE_RATE, dtype="int16",
                             blocksize=chunk_samples) as stream:
            while True:
                data, _ = stream.read(chunk_samples)
                samples = np.array(data, dtype=np.int16).flatten()
                scores = oww.predict(samples)
                for name, score in scores.items():
                    if score >= args.threshold and (time.time() - last_emit) > 1.0:
                        last_emit = time.time()
                        emit({
                            "ok": True,
                            "kind": "detected",
                            "model": name,
                            "score": float(score),
                            "atISO": datetime.now(timezone.utc).isoformat(),
                        })
                        if args.once:
                            return
    except KeyboardInterrupt:
        emit({"ok": True, "kind": "stopped"})


if __name__ == "__main__":
    main()
