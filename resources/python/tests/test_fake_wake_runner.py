"""Smoke test for the E2E-only fake wake-word runner.

The fake exists precisely so the Playwright wake-word suite doesn't need
openwakeword / sounddevice / a real mic installed. This test pins that
contract: the module must import + parse args cleanly even when those
heavy deps are missing from the interpreter.

We don't actually invoke main() (it sleeps and writes to stdout); we just
verify the argparse surface and a minimal end-to-end invocation via
subprocess.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

RUNNER = Path(__file__).resolve().parents[1] / "fake_wake_runner.py"


def test_module_imports_cleanly() -> None:
    """Plain `import fake_wake_runner` must work without any of the
    production runner's heavy ML deps. Imports are dynamic so a broken
    refactor (e.g. accidentally pulling in openwakeword at import time)
    breaks here loud and clear."""
    sys.path.insert(0, str(RUNNER.parent))
    try:
        import importlib

        mod = importlib.import_module("fake_wake_runner")
        # Sanity: the public surface we rely on.
        assert callable(mod.main)
        assert callable(mod._emit)  # noqa: SLF001 — test against the private fn
    finally:
        sys.path.pop(0)


def test_does_not_import_openwakeword_at_module_load() -> None:
    """If a future edit imports `openwakeword` at module-top, this test
    flags it. Spawn a child interpreter that has openwakeword path-blocked,
    then import the fake — should still succeed."""
    code = (
        "import sys\n"
        # Pretend openwakeword + sounddevice are missing.
        "sys.modules['openwakeword'] = None\n"
        "sys.modules['sounddevice'] = None\n"
        f"sys.path.insert(0, {str(RUNNER.parent)!r})\n"
        "import fake_wake_runner\n"
        "print('OK')\n"
    )
    out = subprocess.check_output([sys.executable, "-c", code], stderr=subprocess.STDOUT)
    assert out.decode().strip().endswith("OK")


def test_openww_mode_emits_ready_then_wake() -> None:
    """End-to-end: spawn the script with --mode openww --model X and read
    its stdout. We must see `ready` immediately, then `wake` ~1.5 s later."""
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--mode", "openww", "--model", "hey_jarvis"],
        capture_output=True,
        timeout=6,
    )
    assert proc.returncode == 0, proc.stderr.decode()
    lines = [line for line in proc.stdout.decode().splitlines() if line.strip()]
    assert len(lines) >= 2, f"expected ≥2 events, got: {lines}"
    ready = json.loads(lines[0])
    wake = json.loads(lines[-1])
    assert ready["event"] == "ready"
    assert ready["models"] == ["hey_jarvis"]
    assert wake["event"] == "wake"
    assert wake["model"] == "hey_jarvis"
    assert 0.0 <= wake["score"] <= 1.0


def test_phrase_mode_emits_ready_then_transcript_then_wake() -> None:
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--mode", "phrase", "--phrase", "hey hermes"],
        capture_output=True,
        timeout=6,
    )
    assert proc.returncode == 0, proc.stderr.decode()
    events = [json.loads(line) for line in proc.stdout.decode().splitlines() if line.strip()]
    types = [e["event"] for e in events]
    assert "ready" in types
    assert "transcript" in types
    assert "wake" in types
    ready_evt = next(e for e in events if e["event"] == "ready")
    assert ready_evt["phrase"] == "hey hermes"


def test_unknown_mode_errors_out() -> None:
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--mode", "neither"],
        capture_output=True,
        timeout=5,
    )
    # argparse exits with code 2 on invalid choice.
    assert proc.returncode == 2


@pytest.mark.parametrize("flag,value", [("--threshold", "0.9"), ("--cooldown", "0.3")])
def test_accepts_numeric_overrides_in_openww_mode(flag: str, value: str) -> None:
    """If argparse drifts and these no longer parse, the production
    WakeWordService spawn-arg path would break — pinned here."""
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--mode", "openww", "--model", "x", flag, value],
        capture_output=True,
        timeout=6,
    )
    assert proc.returncode == 0, proc.stderr.decode()
