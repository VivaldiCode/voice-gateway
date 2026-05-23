#!/usr/bin/env python3
"""Wake-word detector loop for Voice Gateway.

Two operating modes:

  --mode openww --model NAME [--model NAME ...]
      The original openWakeWord path. Loads one or more pre-trained models,
      runs them over 80 ms windows at 16 kHz mono, emits a `wake` event each
      time a score crosses --threshold.

  --mode phrase --phrase "hey hermes" --whisper-bin /path --whisper-model /path
      Streams audio into whisper.cpp on rolling ~2 s windows and checks each
      transcript for the user-typed phrase. Uses a basic energy gate so we
      don't transcribe silence. Higher CPU than openWakeWord; only used when
      the user wants an arbitrary wake phrase the openWakeWord catalogue
      doesn't have.

In both modes, stdout is one JSON line per event:

    {"event": "ready", "models": ["hey_jarvis"]}                     # openww
    {"event": "ready", "phrase": "hey hermes"}                       # phrase
    {"event": "wake", "model": "hey_jarvis", "score": 0.78, ...}     # openww
    {"event": "wake", "phrase": "hey hermes", "transcript": "...", "ts": ...}
                                                                       # phrase
    {"event": "transcript", "text": "...", "ts": ...}                # phrase only
    {"event": "error", "message": "..."}

Stderr is human-readable diagnostics. The host process should read stdout
line-by-line and pipe stderr to logs.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

# Add this script's directory to sys.path so `wake_phrase` resolves both in
# dev (resources/python) and in the packaged Resources/python/ layout.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from wake_phrase import matches_wake_phrase, normalize_wake_phrase  # noqa: E402


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


# ────────────── openWakeWord path ──────────────


def run_openww(args: argparse.Namespace) -> int:
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


# ────────────── Phrase (streaming whisper) path ──────────────


def _pcm16_to_wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    """44-byte RIFF header + raw PCM samples. Same shape as src/main/services/stt-service.ts."""
    n = len(pcm)
    header = b"RIFF"
    header += struct.pack("<I", 36 + n)
    header += b"WAVE"
    header += b"fmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data"
    header += struct.pack("<I", n)
    return header + pcm


def _energy_rms(pcm: bytes) -> float:
    """Cheap RMS estimate of an int16 PCM buffer, in [0, 1]. Pure-Python; we
    don't want to require numpy on the phrase-mode path because it pulls in
    a lot when the user only wants a 'hey hermes' detector."""
    if not pcm:
        return 0.0
    # Sum-of-squares with a stride to keep the per-block cost low. For an
    # 800 ms window of 16 kHz int16 (~25k samples) this loop runs 4x slower
    # than numpy but is still <10 ms on a laptop CPU.
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    stride = max(1, n // 1024)
    total = 0.0
    count = 0
    for i in range(0, n, stride):
        sample = struct.unpack_from("<h", pcm, i * 2)[0]
        f = sample / 32768.0
        total += f * f
        count += 1
    return (total / count) ** 0.5 if count else 0.0


def _transcribe(whisper_bin: str, whisper_model: str, wav_bytes: bytes, language: str) -> str:
    """Spawn whisper-cli, feed the WAV via a temp file, return stripped stdout text."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
        f.write(wav_bytes)
    try:
        proc = subprocess.run(
            [
                whisper_bin,
                "-m", whisper_model,
                "-l", language,
                "-nt",  # no timestamps
                "-np",  # suppress whisper.cpp's own log lines on stderr
                "-f", wav_path,
            ],
            capture_output=True,
            timeout=15,
        )
        if proc.returncode != 0:
            tail = proc.stderr.decode("utf-8", errors="replace")[-200:]
            sys.stderr.write(f"[wake-phrase] whisper exit {proc.returncode}: {tail}\n")
            return ""
        return proc.stdout.decode("utf-8", errors="replace").strip()
    except subprocess.TimeoutExpired:
        sys.stderr.write("[wake-phrase] whisper timed out\n")
        return ""
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def _windows(buffer: bytes, window_bytes: int, hop_bytes: int) -> Iterator[bytes]:
    """Yield overlapping windows from `buffer`."""
    n = len(buffer)
    start = 0
    while start + window_bytes <= n:
        yield buffer[start:start + window_bytes]
        start += hop_bytes


def run_phrase(args: argparse.Namespace) -> int:
    try:
        import sounddevice as sd  # noqa: F401
    except Exception as e:  # pragma: no cover - import-time failure
        _emit({"event": "error", "message": f"missing dependency: {e} (need sounddevice)"})
        return 2

    phrase_norm = normalize_wake_phrase(args.phrase)
    if not phrase_norm:
        _emit({"event": "error", "message": "phrase empty after normalisation"})
        return 5
    if not args.whisper_bin or not args.whisper_model:
        _emit(
            {"event": "error", "message": "phrase mode needs --whisper-bin AND --whisper-model"}
        )
        return 6
    if not Path(args.whisper_bin).exists():
        _emit({"event": "error", "message": f"whisper binary not found: {args.whisper_bin}"})
        return 7
    if not Path(args.whisper_model).exists():
        _emit({"event": "error", "message": f"whisper model not found: {args.whisper_model}"})
        return 8

    _emit({"event": "ready", "phrase": phrase_norm})

    sample_rate = args.samplerate
    window_ms = args.window_ms
    hop_ms = args.hop_ms
    window_bytes = sample_rate * 2 * window_ms // 1000  # int16 mono
    hop_bytes = sample_rate * 2 * hop_ms // 1000

    rolling = bytearray()
    last_fire = 0.0
    stop_flag = {"v": False}

    def _stop(_sig, _frame):  # pragma: no cover
        stop_flag["v"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    # Import sounddevice lazily inside the loop body to keep the unit-testable
    # phrase-matching code (above) importable even when sounddevice is missing.
    import sounddevice as sd

    try:
        with sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="int16",
            blocksize=hop_bytes // 2,
        ) as stream:
            while not stop_flag["v"]:
                data, _ = stream.read(hop_bytes // 2)
                rolling.extend(bytes(data))
                # Keep at most 2x the window for memory bounds.
                if len(rolling) > window_bytes * 2:
                    del rolling[: len(rolling) - window_bytes * 2]
                if len(rolling) < window_bytes:
                    continue
                window = bytes(rolling[-window_bytes:])
                rms = _energy_rms(window)
                if rms < args.energy_threshold:
                    continue
                now = time.time()
                if now - last_fire < args.cooldown:
                    continue

                wav = _pcm16_to_wav_bytes(window, sample_rate)
                text = _transcribe(args.whisper_bin, args.whisper_model, wav, args.language)
                if not text:
                    continue
                _emit({"event": "transcript", "text": text, "ts": now})
                if matches_wake_phrase(text, phrase_norm):
                    last_fire = now
                    _emit(
                        {
                            "event": "wake",
                            "phrase": phrase_norm,
                            "transcript": text,
                            "ts": now,
                        }
                    )
    except Exception as e:
        _emit({"event": "error", "message": str(e)})
        return 4

    return 0


# ────────────── argparse + dispatch ──────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["openww", "phrase"], default="openww")
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="openWakeWord model name (repeatable, openww mode only).",
    )
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--cooldown", type=float, default=1.5)
    parser.add_argument("--samplerate", type=int, default=16000)
    parser.add_argument(
        "--chunk", type=int, default=1280, help="openww frame size in samples (80 ms @ 16k)."
    )

    # phrase-mode-only
    parser.add_argument("--phrase", type=str, default="")
    parser.add_argument("--whisper-bin", type=str, default="")
    parser.add_argument("--whisper-model", type=str, default="")
    parser.add_argument("--language", type=str, default="auto")
    parser.add_argument("--window-ms", type=int, default=2000)
    parser.add_argument("--hop-ms", type=int, default=800)
    parser.add_argument(
        "--energy-threshold",
        type=float,
        default=0.005,
        help="RMS gate (0..1). Frames quieter than this skip transcription.",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    if args.mode == "openww":
        if not args.models:
            _emit({"event": "error", "message": "openww mode requires at least one --model"})
            return 1
        return run_openww(args)
    if args.mode == "phrase":
        return run_phrase(args)
    _emit({"event": "error", "message": f"unknown mode: {args.mode}"})
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
