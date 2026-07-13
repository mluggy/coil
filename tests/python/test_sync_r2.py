"""Tests for sync_r2.py — checksum matching and upload logic."""

import hashlib
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

import botocore.exceptions
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

from sync_r2 import md5_of_file, remote_etag, EXTENSIONS


class TestMd5OfFile:
    def test_matches_hashlib(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"hello world")
            path = f.name
        try:
            expected = hashlib.md5(b"hello world").hexdigest()
            assert md5_of_file(path) == expected
        finally:
            os.unlink(path)

    def test_large_file_chunks(self):
        # Exercise the chunked read path
        data = b"x" * (8192 * 3 + 17)
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
            path = f.name
        try:
            assert md5_of_file(path) == hashlib.md5(data).hexdigest()
        finally:
            os.unlink(path)


class TestRemoteEtag:
    def test_returns_etag_without_quotes(self):
        s3 = MagicMock()
        s3.head_object.return_value = {"ETag": '"abc123"'}
        assert remote_etag(s3, "bucket", "key") == "abc123"

    def test_returns_none_on_client_error(self):
        s3 = MagicMock()
        s3.head_object.side_effect = botocore.exceptions.ClientError(
            {"Error": {"Code": "404"}}, "HeadObject"
        )
        assert remote_etag(s3, "bucket", "key") is None


class TestExtensions:
    def test_expected_content_types(self):
        assert EXTENSIONS[".mp3"] == "audio/mpeg"
        assert EXTENSIONS[".srt"] == "application/x-subrip"
        assert EXTENSIONS[".png"] == "image/png"

    def test_rejects_unknown_extensions(self):
        assert ".wav" not in EXTENSIONS
        assert ".txt" in EXTENSIONS  # transcripts are synced alongside audio


class TestMainUploadFlow:
    def _env(self):
        return {
            "R2_ACCESS_KEY_ID": "key",
            "R2_SECRET_ACCESS_KEY": "secret",
            "R2_ENDPOINT_URL": "https://example.com",
            "R2_BUCKET": "bucket",
        }

    def test_skips_matching_etag(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            mp3 = os.path.join(tmpdir, "s1e1.mp3")
            with open(mp3, "wb") as f:
                f.write(b"audio")
            local_md5 = hashlib.md5(b"audio").hexdigest()

            s3 = MagicMock()
            s3.head_object.return_value = {"ETag": f'"{local_md5}"'}

            with patch.dict(os.environ, self._env()), \
                 patch("sync_r2.boto3.client", return_value=s3), \
                 patch("sys.argv", ["sync_r2.py", tmpdir]):
                from sync_r2 import main
                main()

            s3.upload_file.assert_not_called()

    def test_uploads_when_etag_differs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            mp3 = os.path.join(tmpdir, "s1e1.mp3")
            with open(mp3, "wb") as f:
                f.write(b"audio")

            s3 = MagicMock()
            s3.head_object.return_value = {"ETag": '"stale-etag"'}

            with patch.dict(os.environ, self._env()), \
                 patch("sync_r2.boto3.client", return_value=s3), \
                 patch("sys.argv", ["sync_r2.py", tmpdir]):
                from sync_r2 import main
                main()

            s3.upload_file.assert_called_once()
            _, kwargs = s3.upload_file.call_args
            assert kwargs["ExtraArgs"] == {"ContentType": "audio/mpeg"}

    def test_force_skips_etag_check(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            mp3 = os.path.join(tmpdir, "s1e1.mp3")
            with open(mp3, "wb") as f:
                f.write(b"audio")

            s3 = MagicMock()

            with patch.dict(os.environ, self._env()), \
                 patch("sync_r2.boto3.client", return_value=s3), \
                 patch("sys.argv", ["sync_r2.py", tmpdir, "--force"]):
                from sync_r2 import main
                main()

            s3.head_object.assert_not_called()
            s3.upload_file.assert_called_once()

    def test_ignores_unknown_extensions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # .wav is not in EXTENSIONS
            with open(os.path.join(tmpdir, "s1e1.wav"), "wb") as f:
                f.write(b"wave")

            s3 = MagicMock()

            with patch.dict(os.environ, self._env()), \
                 patch("sync_r2.boto3.client", return_value=s3), \
                 patch("sys.argv", ["sync_r2.py", tmpdir]):
                from sync_r2 import main
                main()

            s3.upload_file.assert_not_called()

    def test_missing_env_vars_exits(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {}, clear=True), \
                 patch("sys.argv", ["sync_r2.py", tmpdir]):
                from sync_r2 import main
                with pytest.raises(SystemExit):
                    main()
