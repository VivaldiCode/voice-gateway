#!/usr/bin/env python3
"""Deterministic stand-in for wake_word_runner.py used by the Playwright
wake-word E2E test (VG_WAKE_E2E_FAKE=1).

Speaks the same stdout JSON-line protocol but never opens the mic or loads
any model. Emits `ready` immediately, then `wake` after 1.5 s, then exits.
Lets the renderer's "Testar agora" flow be exercised end-to-end without
depending on openwakeword / whisper / a real microphone.

Reads the same CLI surface as the real runner so the spawn-args plumbing
is also covered.
"""
from __future__ import annotations

import argparse
import json
import sys
import time


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["openww", "phrase"], default="openww")
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument("--phrase", default="")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--cooldown", type=float, default=1.5)
    parser.add_argument("--samplerate", type=int, default=16000)
    parser.add_argument("--chunk", type=int, default=1280)
    parser.add_argument("--whisper-bin", default="")
    parser.add_argument("--whisper-model", default="")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--window-ms", type=int, default=2000)
    parser.add_argument("--hop-ms", type=int, default=800)
    parser.add_argument("--energy-threshold", type=float, default=0.005)
    args = parser.parse_args()

    if args.mode == "openww":
        models = list(args.models) if args.models else ["fake_model"]
        _emit({"event": "ready", "models": models})
        time.sleep(1.5)
        _emit({"event": "wake", "model": models[0], "score": 0.91, "ts": time.time()})
    else:
        phrase = args.phrase or "fake phrase"
        _emit({"event": "ready", "phrase": phrase})
        time.sleep(1.5)
        _emit(
            {
                "event": "transcript",
                "text": f"hey hermes please respond to {phrase}",
                "ts": time.time(),
            }
        )
        _emit({"event": "wake", "phrase": phrase, "transcript": f"hey {phrase}", "ts": time.time()})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
