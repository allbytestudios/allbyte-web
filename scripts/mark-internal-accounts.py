#!/usr/bin/env python3
"""mark-internal-accounts.py — flag owner/test accounts so user metrics exclude them.

    python scripts/mark-internal-accounts.py                      # list every account
    python scripts/mark-internal-accounts.py --email te@x.com     # dry run
    python scripts/mark-internal-accounts.py --email te@x.com --apply
    python scripts/mark-internal-accounts.py --user-id <id> --unset --apply

WHY --------------------------------------------------------------------------

The dashboard counted the owner's own logins and QA fixtures as registrations,
so it reported a user base that does not exist. Same class of error as counting
our own QA traffic as visitors in the play funnel.

Flagged accounts get `internal = 1`. The /admin/stats/users Lambda drops them
from every headline number and reports how many it dropped (`internalAccounts`),
so the exclusion is auditable rather than invisible.

DELIBERATELY NOT AUTOMATIC. Nothing here infers "looks like a test account" from
an email or username. A heuristic would eventually mislabel a real player, and
hiding a genuine signup is far more costly than counting a test account: real
signups are the number the studio is actually trying to grow, and there are very
few of them, so one wrongly hidden is a large relative error.

SAFETY: dry-run by default, prints exactly what it will touch, and only ever
ADDS or REMOVES a flag — it never deletes an account or alters credentials.
Reversible with --unset.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

TABLE = "allbyte-studio-users"


def aws(args: list[str]) -> dict:
    out = subprocess.run(["aws"] + args, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"aws failed: {' '.join(args[:3])}\n{out.stderr.strip()[:400]}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def mask(e: str | None) -> str:
    if not e or "@" not in e:
        return e or "-"
    u, d = e.split("@", 1)
    return (u[:2] + "***") + "@" + d


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--table", default=TABLE)
    ap.add_argument("--email", action="append", default=[], help="exact email (repeatable)")
    ap.add_argument("--user-id", action="append", default=[], help="userId (repeatable)")
    ap.add_argument("--apply", action="store_true", help="actually write the flag")
    ap.add_argument("--unset", action="store_true", help="remove the flag instead of setting it")
    args = ap.parse_args()

    items = aws(["dynamodb", "scan", "--table-name", args.table,
                 "--projection-expression", "userId,email,username,tier,oauthProvider,createdAt,#i",
                 "--expression-attribute-names", '{"#i":"internal"}',
                 "--output", "json"]).get("Items", [])
    g = lambda it, k, t="S": it.get(k, {}).get(t)

    rows = [{
        "id": g(it, "userId"), "email": g(it, "email"), "user": g(it, "username"),
        "tier": g(it, "tier"), "oauth": g(it, "oauthProvider"),
        "created": (g(it, "createdAt") or "")[:10],
        "internal": bool(g(it, "internal", "N") or g(it, "internal", "S")),
    } for it in items]
    rows.sort(key=lambda r: r["created"] or "")

    want_e = {e.lower() for e in args.email}
    want_i = set(args.user_id)
    targets = [r for r in rows
               if (r["email"] or "").lower() in want_e or r["id"] in want_i]

    if not (want_e or want_i):
        print(f"{'created':<12}{'email':<26}{'username':<20}{'tier':<9}{'oauth':<9}{'internal'}")
        for r in rows:
            print(f"{r['created']:<12}{mask(r['email']):<26}{(r['user'] or '-')[:19]:<20}"
                  f"{(r['tier'] or '-'):<9}{(r['oauth'] or '-'):<9}{'YES' if r['internal'] else '-'}")
        print(f"\n{len(rows)} account(s); {sum(1 for r in rows if r['internal'])} flagged internal.")
        print("Pass --email / --user-id to flag. Nothing was changed.")
        return 0

    if not targets:
        print("no accounts matched")
        return 1

    verb = "UNSET internal on" if args.unset else "FLAG as internal"
    print(f"{verb}: {len(targets)} account(s)\n")
    for r in targets:
        print(f"  {r['created']}  {mask(r['email']):<26}{(r['user'] or '-')[:19]:<20}"
              f"{(r['tier'] or '-'):<9}{'(already internal)' if r['internal'] else ''}")

    missed = (want_e | want_i) - {(r["email"] or "").lower() for r in targets} - {r["id"] for r in targets}
    if missed:
        print(f"\n  WARNING: no account matched: {', '.join(sorted(missed))}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return 0

    for r in targets:
        key = json.dumps({"userId": {"S": r["id"]}})
        if args.unset:
            cmd = ["dynamodb", "update-item", "--table-name", args.table, "--key", key,
                   "--update-expression", "REMOVE #i",
                   "--expression-attribute-names", '{"#i":"internal"}']
        else:
            cmd = ["dynamodb", "update-item", "--table-name", args.table, "--key", key,
                   "--update-expression", "SET #i = :one",
                   "--expression-attribute-names", '{"#i":"internal"}',
                   "--expression-attribute-values", '{":one":{"N":"1"}}']
        aws(cmd)
    print(f"\ndone — {len(targets)} account(s) updated. /admin/stats/users excludes them "
          f"and reports the count as internalAccounts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
