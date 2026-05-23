"""Phrase normalisation + matching, kept in sync with src/shared/wake-phrase.ts.

Pure helpers — no I/O. The runner imports `matches_wake_phrase` and uses it
to decide whether a whisper transcript contains the user's typed phrase.

Mirrors the TypeScript logic exactly so the same wake phrase that triggers
in the UI's settings preview also triggers at runtime. Tests in pytest
(tests/test_wake_phrase.py) check the two implementations stay aligned.
"""
from __future__ import annotations

import re
import unicodedata

MIN_WAKE_PHRASE_CHARS = 3
MAX_WAKE_PHRASE_CHARS = 60

_PUNCT_RE = re.compile(r"""[.,!?;:()\[\]{}"'`]""")
_WS_RE = re.compile(r"\s+")


def normalize_wake_phrase(value: object) -> str:
    """Canonicalise a phrase or transcript for matching.

    - drops None / non-string defensively → ""
    - NFD decomposes, then strips combining marks (Mn) so "olá" → "ola"
    - lowercases
    - drops ASCII punctuation Whisper tends to emit
    - collapses internal whitespace, strips edges
    """
    if value is None:
        return ""
    s = str(value)
    decomposed = unicodedata.normalize("NFD", s)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    lowered = stripped.lower()
    no_punct = _PUNCT_RE.sub(" ", lowered)
    collapsed = _WS_RE.sub(" ", no_punct).strip()
    return collapsed


def matches_wake_phrase(transcript: str, phrase: str) -> bool:
    """Return True iff the normalised transcript contains the normalised phrase."""
    t = normalize_wake_phrase(transcript)
    p = normalize_wake_phrase(phrase)
    if not t or not p:
        return False
    if len(p) < MIN_WAKE_PHRASE_CHARS:
        return False
    return p in t
