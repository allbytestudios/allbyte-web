"""Aggregate per-matrix-job QA artifacts into a single run manifest +
update the rolling index of recent runs.

Runs in the `aggregate` job of `.github/workflows/qa.yml` after the
matrix jobs upload their individual artifacts. Reads every JSON file in
the run's S3 prefix, builds a `manifest.json` summarizing what each
matrix job produced, and updates `index.json` at the qa-runs root so
the /test/ dev console can list recent runs without an S3 ListObjects
call.

Environment variables:
  RUN_ID       — the timestamp_sha id assigned by the preflight job
  COMMIT_SHA   — full SHA being QA'd
  BRANCH       — usually "main"
  BUCKET       — S3 bucket name
  TRIGGER      — "workflow_run" or "workflow_dispatch"

S3 layout it writes:
  test-snapshot/qa-runs/
    index.json                              ← rolling list of recent runs
    <run-id>/
      manifest.json                         ← summary of this run
      ubuntu-latest-chromium.json + .png + .logs.txt
      macos-latest-chromium.json + .png + .logs.txt
      ... per OS x engine
      controllers.json
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys

import boto3

INDEX_MAX_RUNS = 30


def main() -> int:
    run_id = os.environ["RUN_ID"]
    commit_sha = os.environ["COMMIT_SHA"]
    branch = os.environ.get("BRANCH", "main")
    bucket = os.environ["BUCKET"]
    trigger = os.environ.get("TRIGGER", "unknown")

    s3 = boto3.client("s3")
    prefix = f"test-snapshot/qa-runs/{run_id}/"

    # List everything in the run's prefix
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            keys.append(obj["Key"])

    print(f"Found {len(keys)} objects under {prefix}")
    for k in keys:
        print(f"  {k}")

    # Parse the per-engine JSONs
    engines: list[dict] = []
    controller_summary: dict | None = None

    for key in keys:
        fname = key.rsplit("/", 1)[-1]
        if not fname.endswith(".json"):
            continue
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            print(f"  WARN: {fname} is not valid JSON, skipping")
            continue

        if fname == "controllers.json":
            controller_summary = summarize_controllers(data)
            continue

        if fname == "manifest.json" or fname == "index.json":
            # Don't re-summarize ourselves
            continue

        # Convention: filename is "<os>-<engine>.json" e.g. "ubuntu-latest-chromium.json"
        stem = fname[: -len(".json")]
        # Split last hyphen as engine, everything before as os name
        if "-" not in stem:
            continue
        parts = stem.rsplit("-", 1)
        if len(parts) != 2:
            continue
        os_name, engine = parts
        engines.append(summarize_engine(data, os_name, engine, run_id))

    # Build manifest
    cross_browser_summary = summarize_cross_browser(engines)
    manifest = {
        "id": run_id,
        "timestamp": iso_from_run_id(run_id),
        "commit_sha": commit_sha,
        "commit_short": commit_sha[:7],
        "branch": branch,
        "trigger": trigger,
        "engines": engines,
        "cross_browser_summary": cross_browser_summary,
        "controller": controller_summary,
        "overall_status": derive_overall_status(cross_browser_summary, controller_summary),
    }

    manifest_key = f"{prefix}manifest.json"
    s3.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public, max-age=60",
    )
    print(f"Wrote manifest: s3://{bucket}/{manifest_key}")

    # Update the rolling index
    update_index(s3, bucket, manifest)
    return 0


def summarize_engine(
    data: dict, os_name: str, engine: str, run_id: str
) -> dict:
    """Squash a per-engine results.json into a single dict for the manifest.

    Cross-browser harness emits {"results": [{engine, status, scene, ...}, ...]}
    where each entry corresponds to one engine the run targeted. Since the
    matrix runs one engine per job, the list has one element.
    """
    results = data.get("results", [])
    if not results:
        return {
            "os": os_name,
            "engine": engine,
            "status": "no_results",
            "screenshot_url": None,
        }
    r = results[0]
    screenshot_url = None
    if r.get("screenshot"):
        screenshot_url = f"/test-snapshot/qa-runs/{run_id}/{os_name}-{engine}.png"
    return {
        "os": os_name,
        "engine": engine,
        "status": r.get("status", "unknown"),
        "scene": r.get("scene"),
        "boot_elapsed_s": r.get("boot_elapsed_s"),
        # Gameplay stages (public build): boot / new_game / movement, each
        # "pass"|"fail". Plus the /play/ embed (real user path) status.
        "stages": r.get("stages"),
        "play_embed": r.get("play_embed"),
        "iframe_log_count": r.get("iframe_log_count", 0),
        "fatal_log_count": r.get("fatal_log_count", 0),
        "suspect_log_count": r.get("suspect_log_count", 0),
        "fatal_samples": r.get("fatal_samples", [])[:3],
        "suspect_samples": r.get("suspect_samples", [])[:5],
        "screenshot_url": screenshot_url,
        "logs_url": f"/test-snapshot/qa-runs/{run_id}/{os_name}-{engine}.logs.txt",
    }


def summarize_controllers(data: dict) -> dict:
    """Squash the controller QA results.json into a single dict."""
    results = data.get("results", [])
    total = len(results)
    passed = 0
    for entry in results:
        r = entry.get("result", {})
        if r.get("status") == "ok":
            s = r.get("summary", {})
            if (
                s.get("buttons_passed") == s.get("buttons_total")
                and s.get("axes_passed") == s.get("axes_total")
            ):
                passed += 1
    return {
        "profiles_total": total,
        "profiles_passed": passed,
        "status": "ok" if total > 0 and passed == total else ("partial" if passed > 0 else "failed"),
    }


def summarize_cross_browser(engines: list[dict]) -> dict:
    total = len(engines)
    ok = sum(1 for e in engines if e.get("status") == "ok")
    fatal = sum(1 for e in engines if (e.get("fatal_log_count") or 0) > 0)
    suspect = sum(1 for e in engines if (e.get("suspect_log_count") or 0) > 0)

    def stage_passed(name: str) -> int:
        return sum(1 for e in engines if (e.get("stages") or {}).get(name) == "pass")

    play_ok = sum(
        1 for e in engines if (e.get("play_embed") or {}).get("status") == "ok"
    )
    return {
        "total": total,
        "passed": ok,
        "with_fatal": fatal,
        "with_suspect": suspect,
        # Per-stage rollups across the matrix so the dashboard can show
        # "movement 6/6" etc. at a glance.
        "play_passed": play_ok,
        "boot_passed": stage_passed("boot"),
        "new_game_passed": stage_passed("new_game"),
        "movement_passed": stage_passed("movement"),
    }


def derive_overall_status(cb: dict, ctrl: dict | None) -> str:
    if cb["total"] == 0:
        return "no_data"
    if cb["with_fatal"] > 0:
        return "failed"
    if cb["passed"] < cb["total"]:
        return "partial"
    if ctrl is not None and ctrl.get("status") != "ok":
        return "partial"
    if cb["with_suspect"] > 0:
        return "suspect"
    return "ok"


def update_index(s3, bucket: str, manifest: dict) -> None:
    """Read the rolling index, prepend this run, trim, write back."""
    index_key = "test-snapshot/qa-runs/index.json"

    try:
        body = s3.get_object(Bucket=bucket, Key=index_key)["Body"].read()
        index = json.loads(body.decode("utf-8"))
    except s3.exceptions.NoSuchKey:
        index = {"version": 1, "runs": []}
    except Exception as e:
        print(f"WARN: couldn't read existing index ({e}); starting fresh")
        index = {"version": 1, "runs": []}

    entry = {
        "id": manifest["id"],
        "timestamp": manifest["timestamp"],
        "commit_short": manifest["commit_short"],
        "commit_sha": manifest["commit_sha"],
        "branch": manifest["branch"],
        "trigger": manifest["trigger"],
        "overall_status": manifest["overall_status"],
        "cross_browser_summary": manifest["cross_browser_summary"],
        "controller_status": (manifest["controller"] or {}).get("status"),
    }

    runs = index.get("runs", [])
    # Replace any existing entry with the same id (re-runs on the same RUN_ID)
    runs = [r for r in runs if r.get("id") != entry["id"]]
    runs.insert(0, entry)
    runs = runs[:INDEX_MAX_RUNS]
    index["runs"] = runs

    s3.put_object(
        Bucket=bucket,
        Key=index_key,
        Body=json.dumps(index, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public, max-age=30",
    )
    print(f"Updated index: s3://{bucket}/{index_key} ({len(runs)} runs)")


def iso_from_run_id(run_id: str) -> str:
    """Convert "2026-06-04T12-00-00Z_abc1234" → "2026-06-04T12:00:00Z"."""
    ts = run_id.split("_", 1)[0]
    # Replace the -hh-mm-ss with :hh:mm:ss
    if ts.count("-") >= 5:
        date_part, time_part = ts.split("T", 1)
        time_part = time_part.replace("-", ":")
        return f"{date_part}T{time_part}"
    return ts


if __name__ == "__main__":
    sys.exit(main())
