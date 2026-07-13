"""Tests for transcribe.py — AWS Transcribe orchestration."""

import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

import transcribe


def _env():
    return {
        "AWS_ACCESS_KEY_ID": "key",
        "AWS_SECRET_ACCESS_KEY": "secret",
        "AWS_REGION": "us-east-1",
        "AWS_S3_BUCKET": "bucket",
    }


def _make_clients(job_states):
    """Return (s3_mock, transcribe_mock) with scripted get_transcription_job responses."""
    s3 = MagicMock()
    tc = MagicMock()
    # Each state is one full job dict
    responses = [{"TranscriptionJob": state} for state in job_states]
    tc.get_transcription_job.side_effect = responses
    return s3, tc


class TestMissingEnv:
    def test_exits_without_env_vars(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {}, clear=True), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                with pytest.raises(SystemExit):
                    transcribe.main()


class TestSkipsExistingSrt:
    def test_mp3_with_existing_srt_skipped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")
            with open(os.path.join(tmpdir, "s1e1.srt"), "w") as f:
                f.write("existing")

            s3, tc = _make_clients([])
            with patch.dict(os.environ, _env()), \
                 patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                transcribe.main()

            s3.upload_file.assert_not_called()
            tc.start_transcription_job.assert_not_called()


class TestCompletedJob:
    def test_downloads_srt_on_completion(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")

            s3, tc = _make_clients([{
                "TranscriptionJobStatus": "COMPLETED",
                "Subtitles": {"SubtitleFileUris": ["https://example.com/out.srt"]},
            }])

            fake_response = MagicMock()
            fake_response.read.return_value = b"1\n00:00:00,000 --> 00:00:01,000\nhi\n"
            fake_response.__enter__ = MagicMock(return_value=fake_response)
            fake_response.__exit__ = MagicMock(return_value=False)

            with patch.dict(os.environ, _env()), \
                 patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                 patch("transcribe.urllib.request.urlopen", return_value=fake_response), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                transcribe.main()

            assert os.path.exists(os.path.join(tmpdir, "s1e1.srt"))
            s3.upload_file.assert_called_once()
            tc.start_transcription_job.assert_called_once()
            tc.delete_transcription_job.assert_called_once()
            s3.delete_object.assert_called_once()


class TestFailedJob:
    def test_no_srt_written_on_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")

            s3, tc = _make_clients([{
                "TranscriptionJobStatus": "FAILED",
                "FailureReason": "audio too short",
            }])

            with patch.dict(os.environ, _env()), \
                 patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                transcribe.main()

            assert not os.path.exists(os.path.join(tmpdir, "s1e1.srt"))
            tc.delete_transcription_job.assert_called_once()
            s3.delete_object.assert_called_once()


class TestCompletedButNoSubtitles:
    def test_handles_missing_subtitle_uris(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")

            s3, tc = _make_clients([{
                "TranscriptionJobStatus": "COMPLETED",
                "Subtitles": {"SubtitleFileUris": []},
            }])

            with patch.dict(os.environ, _env()), \
                 patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                transcribe.main()

            assert not os.path.exists(os.path.join(tmpdir, "s1e1.srt"))


class TestTimeout:
    def test_gives_up_after_max_retries(self, monkeypatch):
        monkeypatch.setattr(transcribe, "MAX_POLL_RETRIES", 2)
        monkeypatch.setattr(transcribe, "POLL_INTERVAL_SECONDS", 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")

            s3, tc = _make_clients([
                {"TranscriptionJobStatus": "IN_PROGRESS"},
                {"TranscriptionJobStatus": "IN_PROGRESS"},
            ])

            with patch.dict(os.environ, _env()), \
                 patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                 patch("sys.argv", ["transcribe.py", tmpdir]):
                transcribe.main()

            assert not os.path.exists(os.path.join(tmpdir, "s1e1.srt"))
            assert tc.get_transcription_job.call_count == 2


class TestLanguageFromConfig:
    def test_uses_language_country_from_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "s1e1.mp3"), "wb") as f:
                f.write(b"mp3")

            s3, tc = _make_clients([{"TranscriptionJobStatus": "FAILED", "FailureReason": "x"}])

            # Patch project_root to point at a scratch dir with a podcast.yaml
            with tempfile.TemporaryDirectory() as rootdir:
                with open(os.path.join(rootdir, "podcast.yaml"), "w") as f:
                    f.write("language: he\ncountry: IL\n")

                from pathlib import Path
                with patch.dict(os.environ, _env()), \
                     patch("transcribe.boto3.client", side_effect=[s3, tc]), \
                     patch("transcribe.project_root", return_value=Path(rootdir)), \
                     patch("sys.argv", ["transcribe.py", tmpdir]):
                    transcribe.main()

            _, kwargs = tc.start_transcription_job.call_args
            assert kwargs["LanguageCode"] == "he-IL"


def _r2_env():
    return {
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
        "R2_ENDPOINT_URL": "https://r2.example.com",
        "R2_BUCKET": "bucket",
    }


def _write_manifest(tmpdir, entries):
    lines = ["episodes:"]
    for number, season in entries:
        lines.append(f"  {number}:")
        lines.append(f"    season: {season}")
        lines.append(f"    title: Episode {number}")
    with open(os.path.join(tmpdir, "episodes.yaml"), "w") as f:
        f.write("\n".join(lines) + "\n")


class TestRestoreMissingMp3s:
    def test_noop_without_r2_env(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_manifest(tmpdir, [(1, 1)])
            with patch.dict(os.environ, {}, clear=True), \
                 patch("transcribe.boto3.client") as client:
                transcribe.restore_missing_mp3s(tmpdir)
            client.assert_not_called()

    def test_downloads_missing_episode(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_manifest(tmpdir, [(54, 2)])
            s3 = MagicMock()
            with patch.dict(os.environ, _r2_env(), clear=True), \
                 patch("transcribe.boto3.client", return_value=s3):
                transcribe.restore_missing_mp3s(tmpdir)
            s3.download_file.assert_called_once_with(
                "bucket", "s2e54.mp3", os.path.join(tmpdir, "s2e54.mp3")
            )

    def test_skips_episode_with_srt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_manifest(tmpdir, [(54, 2)])
            with open(os.path.join(tmpdir, "s2e54.srt"), "w") as f:
                f.write("existing")
            s3 = MagicMock()
            with patch.dict(os.environ, _r2_env(), clear=True), \
                 patch("transcribe.boto3.client", return_value=s3):
                transcribe.restore_missing_mp3s(tmpdir)
            s3.download_file.assert_not_called()

    def test_skips_episode_with_mp3(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_manifest(tmpdir, [(54, 2)])
            with open(os.path.join(tmpdir, "s2e54.mp3"), "wb") as f:
                f.write(b"mp3")
            s3 = MagicMock()
            with patch.dict(os.environ, _r2_env(), clear=True), \
                 patch("transcribe.boto3.client", return_value=s3):
                transcribe.restore_missing_mp3s(tmpdir)
            s3.download_file.assert_not_called()

    def test_download_error_does_not_raise(self, capsys):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_manifest(tmpdir, [(54, 2)])
            s3 = MagicMock()
            s3.download_file.side_effect = Exception("404")
            with patch.dict(os.environ, _r2_env(), clear=True), \
                 patch("transcribe.boto3.client", return_value=s3):
                transcribe.restore_missing_mp3s(tmpdir)
            assert "Could not restore s2e54.mp3" in capsys.readouterr().err
