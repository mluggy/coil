"""Tests for fix_srt.py — SRT file discovery logic."""

import os
import sys
import tempfile

import pytest

# fix_srt imports google.genai at module level, which may not be installed locally.
# We mock it before importing.
sys.modules.setdefault("google", type(sys)("google"))
sys.modules.setdefault("google.genai", type(sys)("google.genai"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

from unittest.mock import MagicMock

import fix_srt as fix_srt_module
from fix_srt import (
    clean_gemini_output,
    count_srt_blocks,
    find_srt_files,
    fix_srt,
    validate_srt_output,
)


class TestFindSrtFiles:
    def test_finds_srt_with_txt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            srt = os.path.join(tmpdir, "s1e1.srt")
            txt = os.path.join(tmpdir, "s1e1.txt")
            open(srt, "w").close()
            open(txt, "w").close()

            result = find_srt_files(tmpdir)
            assert len(result) == 1
            assert result[0][1] is True  # has_txt

    def test_finds_srt_without_txt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            srt = os.path.join(tmpdir, "s1e1.srt")
            open(srt, "w").close()

            result = find_srt_files(tmpdir)
            assert len(result) == 1
            assert result[0][1] is False  # no txt

    def test_filters_by_basename(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for name in ["s1e1.srt", "s1e2.srt", "s1e3.srt"]:
                open(os.path.join(tmpdir, name), "w").close()

            result = find_srt_files(tmpdir, ["s1e2.srt"])
            assert len(result) == 1
            assert "s1e2.srt" in str(result[0][0])

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = find_srt_files(tmpdir)
            assert result == []

    def test_skips_nonexistent_basenames(self, capsys):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = find_srt_files(tmpdir, ["nonexistent.srt"])
            assert result == []


class TestCountSrtBlocks:
    def test_counts_blocks(self):
        text = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        assert count_srt_blocks(text) == 2

    def test_empty_text(self):
        assert count_srt_blocks("") == 0

    def test_bare_number_subtitle_text_not_counted(self):
        # Subtitle text that is itself a bare number (e.g. speaker said "25")
        # must not inflate the block count.
        text = "1\n00:00:01,000 --> 00:00:02,000\n25\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        assert count_srt_blocks(text) == 2


class TestValidateSrtOutput:
    def test_valid_srt_passes(self):
        original = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        corrected = "1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is True

    def test_missing_timestamps_fails(self):
        original = "1\n00:00:01,000 --> 00:00:02,000\nHello\n"
        corrected = "Here is the corrected subtitle file:\nHello World"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is False
        assert "timestamp" in reason

    def test_block_count_mismatch_fails(self):
        original = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        corrected = "1\n00:00:01,000 --> 00:00:02,000\nHello World\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is False
        assert "block count" in reason

    def test_period_separator_accepted(self):
        original = "1\n00:00:01.000 --> 00:00:02.000\nHello\n"
        corrected = "1\n00:00:01.000 --> 00:00:02.000\nHi\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is True

    def test_off_by_one_block_count_fails(self):
        # Previously tolerated (±20% ratio); block counts must now match exactly.
        original = "\n\n".join(
            f"{i}\n00:00:0{i},000 --> 00:00:0{i},500\nline {i}" for i in range(1, 6)
        ) + "\n"
        corrected = "\n\n".join(
            f"{i}\n00:00:0{i},000 --> 00:00:0{i},500\nline {i}" for i in range(1, 5)
        ) + "\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is False
        assert "block count" in reason

    def test_correcting_bare_number_text_passes(self):
        # Regression: s2e54 block 326's text was "25"; Gemini replacing it with
        # words was rejected because the naive counter saw one fewer "block".
        original = "1\n00:00:01,000 --> 00:00:02,000\n25\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        corrected = "1\n00:00:01,000 --> 00:00:02,000\ntwenty-five\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is True

    def test_modified_timestamps_fail(self):
        original = "1\n00:00:01,000 --> 00:00:02,000\nHello\n"
        corrected = "1\n00:00:01,000 --> 00:00:02,500\nHello\n"
        valid, reason = validate_srt_output(original, corrected)
        assert valid is False
        assert "timestamp" in reason


class TestCleanGeminiOutput:
    def test_strips_code_fences(self):
        wrapped = "```srt\n1\n00:00:01,000 --> 00:00:02,000\nHello\n```"
        assert clean_gemini_output(wrapped) == "1\n00:00:01,000 --> 00:00:02,000\nHello\n"

    def test_plain_output_untouched(self):
        plain = "1\n00:00:01,000 --> 00:00:02,000\nHello\n"
        assert clean_gemini_output(plain) == plain

    def test_none_returns_empty(self):
        assert clean_gemini_output(None) == ""


class TestFixSrtRetries:
    SRT = "1\n00:00:01,000 --> 00:00:02,000\nHelo\n"
    GOOD = "1\n00:00:01,000 --> 00:00:02,000\nHello\n"

    def _run(self, tmpdir, response_texts):
        srt_path = os.path.join(tmpdir, "s1e1.srt")
        with open(srt_path, "w") as f:
            f.write(self.SRT)
        client = MagicMock()
        client.models.generate_content.side_effect = [
            MagicMock(text=t) for t in response_texts
        ]
        from pathlib import Path
        ok = fix_srt(client, "model", Path(srt_path), has_txt=False)
        with open(srt_path) as f:
            return ok, f.read(), client.models.generate_content.call_count

    def test_retries_then_succeeds(self, capsys):
        with tempfile.TemporaryDirectory() as tmpdir:
            ok, content, calls = self._run(tmpdir, ["garbage, no timestamps", self.GOOD])
            assert ok is True
            assert content == self.GOOD
            assert calls == 2

    def test_gives_up_and_keeps_original(self, capsys):
        with tempfile.TemporaryDirectory() as tmpdir:
            bad = ["garbage"] * fix_srt_module.MAX_ATTEMPTS
            ok, content, calls = self._run(tmpdir, bad)
            assert ok is False
            assert content == self.SRT
            assert calls == fix_srt_module.MAX_ATTEMPTS
