"""Upload capture artifacts to S3 so the marketing-queue UI can read in prod.

Uploads the clips dir + the full session MP4 + timeline to
s3://<CAPTURE_S3_BUCKET>/<CAPTURE_S3_PREFIX>/. Defaults overwrite the
"latest" location — only one session is exposed via CloudFront at a time.
Older captures can be preserved by overriding CAPTURE_S3_PREFIX per run.

Credential handling: skips silently if AWS creds aren't reachable (no env,
no ~/.aws/credentials inside the container). Production caller mounts
~/.aws read-only or passes AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in
the env. Smoke-test path stays clean.

CloudFront serves the uploaded paths at https://allbyte.studio/captures/...
verified via probe (2026-06-05).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import boto3  # type: ignore
    from botocore.exceptions import NoCredentialsError, BotoCoreError, ClientError  # type: ignore
except ImportError:
    print("[upload] boto3 not installed; install via requirements.txt", file=sys.stderr)
    sys.exit(0)


BUCKET = os.environ.get("CAPTURE_S3_BUCKET", "allbyte.studio-site")
PREFIX = os.environ.get("CAPTURE_S3_PREFIX", "captures/latest").strip("/")


def _content_type(name: str) -> str:
    n = name.lower()
    if n.endswith(".mp4"):
        return "video/mp4"
    if n.endswith(".png"):
        return "image/png"
    if n.endswith(".json"):
        return "application/json"
    if n.endswith(".jpg") or n.endswith(".jpeg"):
        return "image/jpeg"
    return "application/octet-stream"


def _has_credentials() -> bool:
    # Either env-var creds, or a credentials file mounted into the
    # container at ~/.aws/credentials.
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return True
    home = Path(os.environ.get("HOME", "/home/pwuser"))
    return (home / ".aws" / "credentials").exists()


def main() -> int:
    if not _has_credentials():
        print("[upload] no AWS credentials in env or ~/.aws/credentials; skipping upload")
        return 0

    clips_dir_env = os.environ.get("CLIPS_DIR")
    if clips_dir_env:
        clips_dir = Path(clips_dir_env)
    else:
        mp4_path = Path(os.environ.get("MP4_PATH", ""))
        clips_dir = mp4_path.parent / "clips" if mp4_path.name else Path("/home/pwuser/out/clips")

    if not clips_dir.exists():
        print(f"[upload] clips dir not found at {clips_dir}, nothing to upload")
        return 0

    s3 = boto3.client("s3")
    uploaded = 0
    failed = 0

    def _put(local: Path, key: str) -> None:
        nonlocal uploaded, failed
        try:
            s3.upload_file(
                str(local), BUCKET, key,
                ExtraArgs={"ContentType": _content_type(local.name)},
            )
            uploaded += 1
            print(f"[upload] s3://{BUCKET}/{key}")
        except (NoCredentialsError, BotoCoreError, ClientError) as e:
            failed += 1
            print(f"[upload] failed {key}: {type(e).__name__}: {e}", file=sys.stderr)

    # Clips dir (manifest + per-clip files)
    for path in sorted(clips_dir.iterdir()):
        if path.is_file():
            _put(path, f"{PREFIX}/clips/{path.name}")

    # Full session MP4 + timeline at the prefix root, for re-processing
    # later (re-run clip_extractor + caption_drafter on the same source).
    for env_key in ("MP4_PATH", "TIMELINE_PATH"):
        full = Path(os.environ.get(env_key, ""))
        if full.is_file():
            _put(full, f"{PREFIX}/{full.name}")

    print(f"[upload] done: {uploaded} uploaded, {failed} failed → s3://{BUCKET}/{PREFIX}/")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
