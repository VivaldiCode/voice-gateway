"""Argparse smoke test for wake_word_runner.

The runner can't be fully exercised in pytest because openwakeword +
sounddevice need a real microphone and the streaming-whisper path needs
whisper.cpp on disk. But the argparse surface is what `WakeWordService`
relies on for spawn args (see tests/integration/wake-word-service.test.ts).
This file pins the supported flag set so a stray edit to `_build_parser()`
breaks loudly here rather than at runtime inside an Electron child.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wake_word_runner import _build_parser  # noqa: E402


class TestOpenwwArgs:
    def test_parses_minimal_invocation(self) -> None:
        ns = _build_parser().parse_args(["--mode", "openww", "--model", "hey_jarvis"])
        assert ns.mode == "openww"
        assert ns.models == ["hey_jarvis"]
        assert ns.threshold == 0.5  # default
        assert ns.cooldown == 1.5  # default
        assert ns.samplerate == 16000
        assert ns.chunk == 1280

    def test_multiple_models(self) -> None:
        ns = _build_parser().parse_args(
            ["--mode", "openww", "--model", "alexa", "--model", "computer"]
        )
        assert ns.models == ["alexa", "computer"]

    def test_threshold_and_cooldown_override(self) -> None:
        ns = _build_parser().parse_args(
            ["--mode", "openww", "--model", "x", "--threshold", "0.8", "--cooldown", "2.5"]
        )
        assert ns.threshold == pytest.approx(0.8)
        assert ns.cooldown == pytest.approx(2.5)


class TestPhraseArgs:
    def test_parses_phrase_invocation(self) -> None:
        ns = _build_parser().parse_args(
            [
                "--mode", "phrase",
                "--phrase", "hey hermes",
                "--whisper-bin", "/usr/bin/whisper-cli",
                "--whisper-model", "/tmp/ggml-base.bin",
                "--language", "pt",
                "--cooldown", "1.5",
            ]
        )
        assert ns.mode == "phrase"
        assert ns.phrase == "hey hermes"
        assert ns.whisper_bin == "/usr/bin/whisper-cli"
        assert ns.whisper_model == "/tmp/ggml-base.bin"
        assert ns.language == "pt"
        # Window / hop / energy defaults must remain stable — the runner's
        # internal loop relies on them and the wake-word-service test pins
        # the matching cooldown=1.5 string.
        assert ns.window_ms == 2000
        assert ns.hop_ms == 800
        assert ns.energy_threshold == pytest.approx(0.005)

    def test_unknown_flag_errors_out(self) -> None:
        with pytest.raises(SystemExit):
            _build_parser().parse_args(["--mode", "openww", "--bogus", "yes"])

    def test_invalid_mode_errors_out(self) -> None:
        with pytest.raises(SystemExit):
            _build_parser().parse_args(["--mode", "neither"])


class TestDefaults:
    """Pins specific defaults that the TS-side spawn-arg tests reference."""

    def test_default_mode_is_openww(self) -> None:
        ns = _build_parser().parse_args(["--model", "alexa"])
        assert ns.mode == "openww"

    def test_default_language_is_auto(self) -> None:
        ns = _build_parser().parse_args(["--mode", "phrase", "--phrase", "x"])
        assert ns.language == "auto"
