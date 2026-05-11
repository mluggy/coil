#!/usr/bin/env python3
"""Sync podcast episode files to Cloudflare R2."""

import argparse
import hashlib
import os
import sys

import boto3
import botocore.exceptions

sys.path.insert(0, os.path.dirname(__file__))
from shared import validate_env_vars

EXTENSIONS = {
    ".mp3": "audio/mpeg",
    ".srt": "application/x-subrip",
    ".txt": "text/plain; charset=utf-8",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".xml": "application/rss+xml",
}

# When a fork flips `cover` between png and jpg, the OG generator starts
# emitting the new extension but R2 keeps the old keys forever — turning into
# 8MB orphan PNGs alongside the live 800KB JPGs. After each image upload we
# delete the opposite-format key so old orphans get cleaned up on next deploy.
OPPOSITE_IMG_EXT = {".jpg": ".png", ".png": ".jpg"}

# Guardrail: an LFS smudge that silently failed (e.g. bandwidth quota
# exhausted) leaves the working tree with 130-byte pointer text where the
# real binary should be. Uploading that text to R2 overwrites the real
# audio with a stub, breaking every listener. Detect and refuse.
LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"


def is_lfs_pointer(path):
    try:
        with open(path, "rb") as f:
            return f.read(len(LFS_POINTER_PREFIX)) == LFS_POINTER_PREFIX
    except OSError:
        return False


def md5_of_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_etag(s3, bucket, key):
    try:
        resp = s3.head_object(Bucket=bucket, Key=key)
        return resp["ETag"].strip('"')
    except botocore.exceptions.ClientError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Sync episode files to Cloudflare R2")
    parser.add_argument("episodes_dir", help="Path to the episodes directory")
    parser.add_argument("--force", action="store_true", help="Upload all files regardless of ETag")
    args = parser.parse_args()

    validate_env_vars(
        ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL", "R2_BUCKET"]
    )

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ.get("R2_ENDPOINT_URL"),
        aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY"),
    )
    bucket = os.environ.get("R2_BUCKET")

    failures = 0
    for entry in sorted(os.listdir(args.episodes_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in EXTENSIONS:
            continue

        local_path = os.path.join(args.episodes_dir, entry)
        if not os.path.isfile(local_path):
            continue

        if is_lfs_pointer(local_path):
            failures += 1
            print(
                f"Refusing to upload {entry}: file is a Git LFS pointer, "
                "not real content. The LFS smudge filter likely failed "
                "(bandwidth/quota?). Fix LFS in the runner and rerun.",
                file=sys.stderr,
            )
            continue

        key = entry
        content_type = EXTENSIONS[ext]

        try:
            if not args.force:
                local_md5 = md5_of_file(local_path)
                r_etag = remote_etag(s3, bucket, key)
                if r_etag == local_md5:
                    continue

            s3.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": content_type})
            print(key)
            # Prune the opposite image format (e.g. uploaded s1e1.jpg → drop
            # any leftover s1e1.png). apple-touch-icon.png stays put — it's
            # never tracked here.
            if ext in OPPOSITE_IMG_EXT:
                stale_key = os.path.splitext(key)[0] + OPPOSITE_IMG_EXT[ext]
                try:
                    s3.delete_object(Bucket=bucket, Key=stale_key)
                except botocore.exceptions.ClientError:
                    pass
        except Exception as exc:
            failures += 1
            print(f"Error uploading {key}: {exc}", file=sys.stderr)

    if failures:
        sys.exit(f"sync_r2: {failures} upload(s) failed")


if __name__ == "__main__":
    main()
