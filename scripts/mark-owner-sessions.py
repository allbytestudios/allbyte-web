#!/usr/bin/env python3
"""mark-owner-sessions.py — retroactively tag play-funnel sessions as the owner's.

    # see what would be tagged (DEFAULT — writes nothing)
    python scripts/mark-owner-sessions.py --device "macOS Safari" --since 2026-09-14
    python scripts/mark-owner-sessions.py --session 1a2b3c... --session 4d5e6f...

    # actually write the flag
    python scripts/mark-owner-sessions.py --device "macOS Safari" --since 2026-09-14 --apply

WHY THIS EXISTS -----------------------------------------------------------------

playAnalytics.ts already suppresses beacons for the owner two ways: a `?owner=1`
visit persists `ab_play_owner` in localStorage for that device, and being signed
in as admin excludes every device automatically. Neither covers the real gap:

  * a browser where the owner is signed OUT and has never used ?owner=1, and
  * Safari specifically — ITP evicts localStorage after ~7 days idle, so a device
    that WAS marked silently rejoins the funnel later.

That is how the owner's macOS Safari and iOS Safari sessions ended up counted as
players. This script is the retroactive backstop: it writes `owner=1` onto the
matching rows, and the read Lambda drops owner-flagged sessions from every metric
the same way it drops datacenter bots.

GOING FORWARD, the cheap durable fix is one visit per device:
    https://allbyte.studio/play/?owner=1
On Safari, re-do it if you have not opened the site in a week or so — that is an
ITP limitation, not something the site can defeat from JavaScript.

SAFETY: dry-run by default. It prints exactly which sessions match and how many
rows would change; nothing is written without --apply. It only ever ADDS a flag —
it never deletes rows or alters play data, so a mistake is reversible with
--unset.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import subprocess
import sys

TABLE = "allbyte-studio-play-funnel"


def aws(args: list[str]) -> dict:
    out = subprocess.run(["aws"] + args, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"aws failed: {' '.join(args[:3])}\n{out.stderr.strip()[:400]}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def parse_day(s: str) -> int:
    return int(dt.datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--table", default=TABLE)
    ap.add_argument("--session", action="append", default=[], help="session id (repeatable)")
    ap.add_argument("--device", help='device string, e.g. "macOS Safari" / "iOS Safari"')
    ap.add_argument("--ref", help="referrer bucket, e.g. internal")
    ap.add_argument("--since", help="UTC day, inclusive (YYYY-MM-DD)")
    ap.add_argument("--until", help="UTC day, exclusive (YYYY-MM-DD)")
    ap.add_argument("--apply", action="store_true", help="actually write the flag")
    ap.add_argument("--unset", action="store_true", help="remove the flag instead of setting it")
    args = ap.parse_args()

    if not (args.session or args.device or args.ref or args.since):
        sys.exit("refusing to match everything — pass --session/--device/--ref/--since")

    items = aws(["dynamodb", "scan", "--table-name", args.table,
                 "--projection-expression", "sessionId,sk,ts,ev,dev,#r,dur,#o",
                 "--expression-attribute-names", '{"#r":"ref","#o":"owner"}',
                 "--output", "json"]).get("Items", [])

    g = lambda it, k, t="S": it.get(k, {}).get(t)
    sess = collections.defaultdict(lambda: {"rows": [], "dev": None, "ref": None, "ts": [], "dur": 0, "owner": False})
    for it in items:
        sid = g(it, "sessionId")
        if not sid:
            continue
        r = sess[sid]
        r["rows"].append((sid, g(it, "sk")))
        r["dev"] = r["dev"] or g(it, "dev")
        r["ref"] = r["ref"] or g(it, "ref")
        if g(it, "owner", "N"):
            r["owner"] = True
        try:
            r["ts"].append(int(g(it, "ts", "N") or 0))
            r["dur"] = max(r["dur"], int(g(it, "dur", "N") or 0))
        except (TypeError, ValueError):
            pass

    want = set(args.session)
    since = parse_day(args.since) if args.since else None
    until = parse_day(args.until) if args.until else None

    matched = {}
    for sid, r in sess.items():
        if want and sid not in want:
            continue
        if args.device and (r["dev"] or "") != args.device:
            continue
        if args.ref and (r["ref"] or "") != args.ref:
            continue
        last = max(r["ts"]) if r["ts"] else 0
        if since and last < since:
            continue
        if until and last >= until:
            continue
        matched[sid] = r

    if not matched:
        print("no sessions matched")
        return 0

    rows = sum(len(r["rows"]) for r in matched.values())
    verb = "UNSET owner on" if args.unset else "TAG as owner"
    print(f"{verb}: {len(matched)} session(s), {rows} row(s)\n")
    for sid, r in sorted(matched.items(), key=lambda kv: -(max(kv[1]['ts']) if kv[1]['ts'] else 0)):
        when = dt.datetime.utcfromtimestamp(max(r["ts"])).strftime("%Y-%m-%d %H:%M UTC") if r["ts"] else "?"
        print(f"  {when} · {r['dev']} · via {r['ref']} · {r['dur']}s · rows={len(r['rows'])}"
              f"{' · ALREADY owner' if r['owner'] else ''}\n    {sid}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to commit.")
        return 0

    changed = 0
    for sid, r in matched.items():
        for _, sk in r["rows"]:
            key = json.dumps({"sessionId": {"S": sid}, "sk": {"S": sk}})
            if args.unset:
                cmd = ["dynamodb", "update-item", "--table-name", args.table, "--key", key,
                       "--update-expression", "REMOVE #o",
                       "--expression-attribute-names", '{"#o":"owner"}']
            else:
                cmd = ["dynamodb", "update-item", "--table-name", args.table, "--key", key,
                       "--update-expression", "SET #o = :one",
                       "--expression-attribute-names", '{"#o":"owner"}',
                       "--expression-attribute-values", '{":one":{"N":"1"}}']
            aws(cmd)
            changed += 1
    print(f"\ndone — {changed} row(s) updated across {len(matched)} session(s).")
    print("The funnel dashboard and play-report.py both drop owner-flagged sessions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
