"""Tests for the pure helpers in wake_word_runner.py.

We don't test the full sounddevice loop here (would need a real mic); we
just test the byte-twiddling helpers so the WAV header layout doesn't
silently drift and whisper.cpp keeps accepting our input.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wake_word_runner import _energy_rms, _pcm16_to_wav_bytes, _windows  # noqa: E402


class TestPcm16ToWav:
    def test_header_is_44_bytes(self) -> None:
        pcm = b"\x00\x00" * 16  # 16 samples of silence
        wav = _pcm16_to_wav_bytes(pcm, 16000)
        assert len(wav) == 44 + len(pcm)

    def test_riff_marker_and_format(self) -> None:
        wav = _pcm16_to_wav_bytes(b"\x00\x00" * 8, 16000)
        assert wav[0:4] == b"RIFF"
        assert wav[8:12] == b"WAVE"
        assert wav[12:16] == b"fmt "

    def test_sample_rate_round_trips_in_header(self) -> None:
        wav = _pcm16_to_wav_bytes(b"\x00\x00" * 8, 22050)
        # bytes 24..28 are the little-endian sample rate.
        (sr,) = struct.unpack_from("<I", wav, 24)
        assert sr == 22050

    def test_data_chunk_length_matches_payload(self) -> None:
        pcm = b"\x01\x00" * 100  # 100 samples
        wav = _pcm16_to_wav_bytes(pcm, 16000)
        (data_len,) = struct.unpack_from("<I", wav, 40)
        assert data_len == len(pcm)
        assert wav[44:] == pcm


class TestEnergyRms:
    def test_silence_is_zero(self) -> None:
        assert _energy_rms(b"\x00\x00" * 100) == 0.0

    def test_empty_buffer_is_zero(self) -> None:
        assert _energy_rms(b"") == 0.0

    def test_full_scale_is_close_to_one(self) -> None:
        # Max positive int16 across the whole buffer.
        peak = struct.pack("<h", 32767)
        rms = _energy_rms(peak * 256)
        # Stride sampling means we don't hit exact 1.0, but should be very close.
        assert 0.99 < rms <= 1.0

    def test_quiet_signal_is_low(self) -> None:
        quiet = struct.pack("<h", 100)  # ~3 thousandths of full scale
        rms = _energy_rms(quiet * 256)
        # rms ≈ 100/32768 ≈ 0.003
        assert rms < 0.01


class TestWindows:
    def test_yields_overlapping_chunks(self) -> None:
        buf = bytes(range(20))
        out = list(_windows(buf, window_bytes=8, hop_bytes=4))
        # 20 bytes, window 8, hop 4 → starts at 0, 4, 8, 12 (12+8=20 fits, 16+8=24 doesn't)
        assert len(out) == 4
        assert out[0] == buf[0:8]
        assert out[1] == buf[4:12]
        assert out[3] == buf[12:20]

    def test_no_window_yielded_when_buffer_too_short(self) -> None:
        assert list(_windows(bytes(5), window_bytes=8, hop_bytes=4)) == []

    def test_single_window_when_exactly_window_size(self) -> None:
        buf = bytes(8)
        out = list(_windows(buf, window_bytes=8, hop_bytes=4))
        assert out == [buf]
