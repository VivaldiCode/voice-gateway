"""Pytest mirror of tests/unit/wake-phrase.test.ts.

Keeps the TypeScript and Python normalisers aligned: every meaningful
assertion in the TS suite has a counterpart here, so a drift in either
implementation surfaces in CI.

Run from the repo root:
    PYTHONPATH=resources/python python3 -m pytest resources/python/tests
"""
from __future__ import annotations

import sys
from pathlib import Path

# Add resources/python so `wake_phrase` resolves when running outside the repo's
# normal python path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wake_phrase import (  # noqa: E402
    MAX_WAKE_PHRASE_CHARS,
    MIN_WAKE_PHRASE_CHARS,
    matches_wake_phrase,
    normalize_wake_phrase,
)


class TestNormalizeWakePhrase:
    def test_returns_empty_for_none(self) -> None:
        assert normalize_wake_phrase(None) == ""

    def test_returns_empty_for_empty_or_whitespace(self) -> None:
        assert normalize_wake_phrase("") == ""
        assert normalize_wake_phrase("   \n\t   ") == ""

    def test_lowercases(self) -> None:
        assert normalize_wake_phrase("Hey HERMES") == "hey hermes"

    def test_collapses_internal_whitespace(self) -> None:
        assert normalize_wake_phrase("hey\t\nhermes  amigo") == "hey hermes amigo"

    def test_strips_ascii_punctuation(self) -> None:
        assert normalize_wake_phrase("Hey, Hermes! Are you there?") == "hey hermes are you there"
        assert normalize_wake_phrase('"olá" (oi)') == "ola oi"

    def test_strips_diacritics(self) -> None:
        assert normalize_wake_phrase("olá") == "ola"
        assert normalize_wake_phrase("Olá Hermès") == "ola hermes"
        assert normalize_wake_phrase("café com leite") == "cafe com leite"

    def test_is_idempotent(self) -> None:
        once = normalize_wake_phrase("Hey, Hermès!")
        twice = normalize_wake_phrase(once)
        assert once == twice

    def test_handles_non_string_defensively(self) -> None:
        # Mirror the TS coercion: integers stringify cleanly.
        assert normalize_wake_phrase(42) == "42"


class TestMatchesWakePhrase:
    def test_exact_match(self) -> None:
        assert matches_wake_phrase("hey hermes", "hey hermes") is True

    def test_case_and_punctuation_insensitive(self) -> None:
        # The common whisper case: transcript has punctuation + caps.
        assert matches_wake_phrase("Hey, Hermes!", "hey hermes") is True

    def test_phrase_inside_longer_transcript(self) -> None:
        assert matches_wake_phrase("então, hey hermes, podes ouvir?", "hey hermes") is True

    def test_diacritic_normalisation_both_directions(self) -> None:
        assert matches_wake_phrase("Hey, Hermès.", "hey hermes") is True
        assert matches_wake_phrase("olá amigo", "ola amigo") is True
        assert matches_wake_phrase("ola amigo", "olá amigo") is True

    def test_absent_phrase_returns_false(self) -> None:
        assert matches_wake_phrase("algo completamente diferente", "hey hermes") is False

    def test_empty_inputs_return_false(self) -> None:
        assert matches_wake_phrase("", "hey hermes") is False
        assert matches_wake_phrase("hey hermes", "") is False

    def test_too_short_phrase_rejected(self) -> None:
        # Mirrors MIN_WAKE_PHRASE_CHARS guard in the TS implementation.
        assert matches_wake_phrase("hey jarvis ah hello", "a") is False
        assert matches_wake_phrase("xy hello world", "xy") is False

    def test_trailing_periods(self) -> None:
        assert matches_wake_phrase("Hey Hermes.", "hey hermes") is True
        assert matches_wake_phrase("Hey Hermes...", "hey hermes") is True


class TestBoundConstants:
    def test_constants_within_sane_range(self) -> None:
        assert MIN_WAKE_PHRASE_CHARS > 0
        assert MAX_WAKE_PHRASE_CHARS > MIN_WAKE_PHRASE_CHARS

    def test_constants_match_typescript_side(self) -> None:
        # Hard-coded duplicates so a TS drift (e.g. dropping MIN to 2) doesn't
        # silently change Python's behaviour. If you bump one side, bump both.
        assert MIN_WAKE_PHRASE_CHARS == 3
        assert MAX_WAKE_PHRASE_CHARS == 60
