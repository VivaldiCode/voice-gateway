#!/usr/bin/env python3
"""Wake-word detector loop for Voice Gateway.

Reads from the default system microphone, runs `openwakeword` over rolling
80 ms windows at 16 kHz mono, and writes one JSON line per event to stdout.

Stdout JSON shape:
    {"event": "ready", "models": ["hey_jarvis"]}
    {"event": "wake", "model": "hey_jarvis", "score": 0.78, "ts": 1719000000.0}
    {"event": "error", "message": "..."}

Stderr is used for human-readable diagnostics. The host process should read
stdout line-by-line and pipe stderr to logs.

Args:
    --model NAME ...   one or more openwakeword model names (repeatable)
    --threshold 0.5    activation score in [0,1]
    --cooldown 1.5     seconds to suppress repeat triggers per model
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from typing import List


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", required=True, dest="models")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--cooldown", type=float, default=1.5)
    parser.add_argument("--samplerate", type=int, default=16000)
    parser.add_argument("--chunk", type=int, default=1280)  # 80 ms @ 16k
    args = parser.parse_args()

    try:
        import numpy as np
        import sounddevice as sd
        from openwakeword.model import Model
    except Exception as e:  # pragma: no cover - import-time failure
        _emit({"event": "error", "message": f"missing dependency: {e}"})
        return 2

    try:
        model = Model(wakeword_models=list(args.models))
    except Exception as e:
        _emit({"event": "error", "message": f"failed to load models: {e}"})
        return 3

    _emit({"event": "ready", "models": list(args.models)})

    last_fire: dict[str, float] = {}
    stop_flag = {"v": False}

    def _stop(_sig, _frame):  # pragma: no cover
        stop_flag["v"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    try:
        with sd.InputStream(
            samplerate=args.samplerate,
            channels=1,
            dtype="int16",
            blocksize=args.chunk,
        ) as stream:
            while not stop_flag["v"]:
                data, _ = stream.read(args.chunk)
                frame = np.frombuffer(data, dtype=np.int16)
                scores = model.predict(frame)
                now = time.time()
                for name, score in scores.items():
                    if score < args.threshold:
                        continue
                    if now - last_fire.get(name, 0.0) < args.cooldown:
                        continue
                    last_fire[name] = now
                    _emit(
                        {
                            "event": "wake",
                            "model": name,
                            "score": float(score),
                            "ts": now,
                        }
                    )
    except Exception as e:
        _emit({"event": "error", "message": str(e)})
        return 4

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
