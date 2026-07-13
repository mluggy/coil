#!/usr/bin/env python3
"""Transcribe MP3 files to SRT via AWS Transcribe, staging through S3."""

import argparse
import glob
import os
import sys
import time
import urllib.request

import boto3
import yaml

sys.path.insert(0, os.path.dirname(__file__))
from shared import project_root, validate_env_vars


POLL_INTERVAL_SECONDS = 5
MAX_POLL_RETRIES = 120

R2_ENV_VARS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL", "R2_BUCKET"]


def manifest_basenames(episodes_dir):
    """Return sNeM basenames for every episode in episodes.yaml."""
    manifest_path = os.path.join(episodes_dir, "episodes.yaml")
    if not os.path.exists(manifest_path):
        return []
    with open(manifest_path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    basenames = []
    for number, episode in (data.get("episodes") or {}).items():
        season = (episode or {}).get("season")
        if season is None:
            continue
        basenames.append(f"s{season}e{number}")
    return basenames


def restore_missing_mp3s(episodes_dir):
    """Download MP3s from R2 for manifest episodes missing both .mp3 and .srt.

    MP3s are gitignored (R2 is canonical), so deleting a bad .srt leaves the
    checkout with no audio to re-transcribe from. Pull the audio back first.
    Silently a no-op when R2 credentials aren't configured.
    """
    if not all(os.environ.get(v) for v in R2_ENV_VARS):
        return

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )
    bucket = os.environ["R2_BUCKET"]

    for basename in manifest_basenames(episodes_dir):
        mp3_path = os.path.join(episodes_dir, f"{basename}.mp3")
        srt_path = os.path.join(episodes_dir, f"{basename}.srt")
        if os.path.exists(mp3_path) or os.path.exists(srt_path):
            continue
        try:
            s3.download_file(bucket, f"{basename}.mp3", mp3_path)
            # stderr — stdout is reserved for new SRT basenames the caller captures
            print(f"Restored {basename}.mp3 from R2 for re-transcription", file=sys.stderr)
        except Exception as e:
            print(f"Could not restore {basename}.mp3 from R2: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe MP3 files in EPISODES_DIR using AWS Transcribe."
    )
    parser.add_argument("episodes_dir", help="Path to episodes directory")
    args = parser.parse_args()

    validate_env_vars(
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET"]
    )

    config_path = project_root() / "podcast.yaml"
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f) or {}
    else:
        config = {}
    lang = config.get("language", "en")
    country = config.get("country", "US")
    transcribe_language_code = f"{lang}-{country}"

    aws_region = os.environ["AWS_REGION"]
    bucket = os.environ["AWS_S3_BUCKET"]

    s3_client = boto3.client("s3", region_name=aws_region)
    transcribe_client = boto3.client("transcribe", region_name=aws_region)

    restore_missing_mp3s(args.episodes_dir)

    mp3_files = glob.glob(os.path.join(args.episodes_dir, "*.mp3"))

    for mp3_path in mp3_files:
        basename = os.path.splitext(os.path.basename(mp3_path))[0]
        srt_path = os.path.join(args.episodes_dir, f"{basename}.srt")

        if os.path.exists(srt_path):
            continue

        try:
            filename = os.path.basename(mp3_path)
            s3_key = f"transcribe-staging/{filename}"
            s3_uri = f"s3://{bucket}/{s3_key}"

            s3_client.upload_file(mp3_path, bucket, s3_key)

            job_name = f"podcast-{basename}-{int(time.time())}"

            transcribe_client.start_transcription_job(
                TranscriptionJobName=job_name,
                Media={"MediaFileUri": s3_uri},
                LanguageCode=transcribe_language_code,
                Subtitles={"Formats": ["srt"], "OutputStartIndex": 1},
            )

            for retries in range(MAX_POLL_RETRIES):
                resp = transcribe_client.get_transcription_job(
                    TranscriptionJobName=job_name
                )
                job = resp["TranscriptionJob"]
                status = job["TranscriptionJobStatus"]

                if status == "COMPLETED":
                    subtitle_uris = job.get("Subtitles", {}).get("SubtitleFileUris", [])
                    if not subtitle_uris:
                        print(
                            f"Transcription for {basename} completed without subtitle output",
                            file=sys.stderr,
                        )
                        break
                    with urllib.request.urlopen(subtitle_uris[0]) as response:
                        srt_content = response.read()
                    with open(srt_path, "wb") as f:
                        f.write(srt_content)
                    print(f"{basename}.srt")
                    break

                if status == "FAILED":
                    reason = job.get("FailureReason", "unknown")
                    print(
                        f"Transcription failed for {basename}: {reason}",
                        file=sys.stderr,
                    )
                    break

                time.sleep(POLL_INTERVAL_SECONDS)
            else:
                print(
                    f"Transcription timed out for {basename} after "
                    f"{MAX_POLL_RETRIES * POLL_INTERVAL_SECONDS}s",
                    file=sys.stderr,
                )

            transcribe_client.delete_transcription_job(TranscriptionJobName=job_name)
            s3_client.delete_object(Bucket=bucket, Key=s3_key)

        except Exception as e:
            print(f"Error processing {basename}: {e}", file=sys.stderr)
            continue


if __name__ == "__main__":
    main()
