#!/usr/bin/env python3
"""play-report.py — dump recent real-player activity from the play-depth funnel.

    python scripts/play-report.py                 # last 14 days -> infrastructure/reports/
    python scripts/play-report.py --days 30
    python scripts/play-report.py --out -         # stdout instead of a file

WHAT IT ANSWERS: are people actually PLAYING, and how far do they get? Session
counts can't tell a bounce from a 25-minute run, so this reports TIME and
PROGRESS per session.

WHO IT EXCLUDES (and why those rules, not others) --------------------------------

* Datacenter bots      - `bot` flag, set SERVER-SIDE from the connection's source
                         IP by the write Lambda. Never guessed here.
* Known automation     - `auto` flag. Mostly historical: since the client-side
                         `navigator.webdriver` check landed, headless browsers
                         send NO beacons at all, so our own Playwright/CI runs
                         are absent from this table rather than filtered from it.
* Owner play           - CANNOT be identified. Beacons are deliberately anonymous
                         (session-scoped random id, no account link), so the
                         owner's own sessions are indistinguishable from a
                         player's. Use --exclude-session <id> for ones you
                         recognise; see OWNER EXCLUSION below for the real fix.

A TRAP WORTH KNOWING: `ref=internal` does NOT mean internal/QA traffic. It means
a SAME-SITE referrer — someone who clicked Play from the homepage, i.e. the
healthiest inbound path there is (playAnalytics.ts maps it to "homepage_cta").
An earlier hand-analysis threw those out as "our own QA" and made the funnel look
far worse than it was. They are counted as real players here.

OWNER EXCLUSION, properly: the durable fix is a marker the owner's browsers set
once -- localStorage `allbyte_no_analytics` -- which playAnalytics.ts would honour
by suppressing beacons the same way it does for webdriver. Until that exists,
this script can only flag suspicious-looking sessions, not owner ones.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import subprocess
import sys

TABLE = "allbyte-studio-play-funnel"
# Startup instrumentation + UI markers are not places a player "went".
NOISE_PREFIX = ("s:", "m:")


def scan(table: str) -> list[dict]:
    """Full table scan via the AWS CLI (auto-paginates). Projection keeps it small."""
    cmd = [
        "aws", "dynamodb", "scan", "--table-name", table,
        # `ref` and `auto` are DynamoDB reserved words — both need aliasing.
        "--projection-expression", "sessionId,ts,ev,scene,dev,#r,dur,bot,#a,ctx,#o",
        "--expression-attribute-names", '{"#r":"ref","#a":"auto","#o":"owner"}',
        "--output", "json",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"scan failed: {out.stderr.strip()[:400]}")
    return json.loads(out.stdout).get("Items", [])


def val(item: dict, key: str, kind: str = "S"):
    return item.get(key, {}).get(kind)


def build_sessions(items: list[dict]) -> dict:
    s: dict = collections.defaultdict(
        lambda: {
            "ts": [], "scenes": [], "dev": None, "ref": None, "ctx": None,
            "dur": 0, "bot": False, "auto": False, "owner": False, "evs": collections.Counter(),
        }
    )
    for it in items:
        sid = val(it, "sessionId")
        if not sid:
            continue
        rec = s[sid]
        ts = int(val(it, "ts", "N") or 0)
        if ts:
            rec["ts"].append(ts)
        ev = val(it, "ev") or "?"
        rec["evs"][ev] += 1
        rec["dev"] = rec["dev"] or val(it, "dev")
        rec["ref"] = rec["ref"] or val(it, "ref")
        rec["ctx"] = rec["ctx"] or val(it, "ctx")
        try:
            rec["dur"] = max(rec["dur"], int(val(it, "dur", "N") or 0))
        except (TypeError, ValueError):
            pass
        if val(it, "bot", "N") or val(it, "bot", "S"):
            rec["bot"] = True
        if val(it, "auto", "N") or val(it, "auto", "S"):
            rec["auto"] = True
        if val(it, "owner", "N") or val(it, "owner", "S"):
            rec["owner"] = True
        sc = val(it, "scene")
        if ev == "scene" and sc:
            rec["scenes"].append((ts, sc))
    return s


def ordered(rec: dict, games_only: bool = False) -> list[str]:
    out: list[str] = []
    for _, sc in sorted(rec["scenes"]):
        if not sc:
            continue
        if games_only and sc.startswith(NOISE_PREFIX):
            continue
        if not out or out[-1] != sc:
            out.append(sc)
    return out


def suspicious(rec: dict) -> list[str]:
    """Flag shapes worth a human glance. Deliberately conservative — these are
    PREFACED, not excluded, so a real player is never silently dropped."""
    flags = []
    game = ordered(rec, games_only=True)
    span = (max(rec["ts"]) - min(rec["ts"])) if rec["ts"] else 0
    if rec["dur"] > 6 * 3600:
        flags.append("implausible duration (>6h — tab left open?)")
    if len(game) >= 8 and span < 60:
        flags.append(f"{len(game)} scenes in {span}s — too fast for real play")
    if rec["evs"].get("open", 0) > 5:
        flags.append(f"{rec['evs']['open']} open events in one session")
    if not rec["scenes"] and rec["dur"] > 900:
        flags.append("long session, zero scenes — never booted but stayed open")
    return flags


def fmt_dur(s: int) -> str:
    if not s:
        return "0s"
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    return f"{s // 3600}h {(s % 3600) // 60}m"


def ts_str(t: int) -> str:
    return dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d %H:%M UTC")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=14, help="window size (default 14)")
    ap.add_argument("--table", default=TABLE)
    ap.add_argument("--out", default="", help="output path, or '-' for stdout")
    ap.add_argument("--exclude-session", action="append", default=[],
                    help="session id to drop (repeatable) — use for runs you recognise as your own")
    args = ap.parse_args()

    items = scan(args.table)
    sess = build_sessions(items)
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    cut = now - args.days * 86400

    window = {k: v for k, v in sess.items() if v["ts"] and max(v["ts"]) >= cut}
    dropped = {k: v for k, v in window.items() if k in set(args.exclude_session)}
    bots = {k: v for k, v in window.items() if v["bot"] and k not in dropped}
    autos = {k: v for k, v in window.items() if v["auto"] and not v["bot"] and k not in dropped}
    owners = {k: v for k, v in window.items() if v["owner"] and not v["bot"] and not v["auto"] and k not in dropped}
    real = {k: v for k, v in window.items()
            if not v["bot"] and not v["auto"] and not v["owner"] and k not in dropped}

    players = {k: v for k, v in real.items() if ordered(v, True)}
    nonboot = {k: v for k, v in real.items() if not ordered(v, True)}
    played_secs = sorted(v["dur"] for v in players.values() if v["dur"] > 0)
    total_play = sum(played_secs)
    median_play = played_secs[len(played_secs) // 2] if played_secs else 0

    L: list[str] = []
    w = L.append
    w(f"# Player activity — last {args.days} days\n")
    w(f"Generated {ts_str(now)} from DynamoDB `{args.table}` "
      f"({len(items)} beacons, {len(sess)} sessions all-time).\n")
    w(f"Window: **{ts_str(cut)} → {ts_str(now)}**\n")

    w("## Headline\n")
    w(f"- **{len(real)} real sessions**, of which **{len(players)} actually played** "
      f"(got past the startup markers into a game scene).")
    w(f"- **{fmt_dur(total_play)} played in total**; median run **{fmt_dur(median_play)}**; "
      f"longest **{fmt_dur(max(played_secs) if played_secs else 0)}**.")
    w(f"- {len(nonboot)} sessions arrived but never reached a game scene.")
    w(f"- Excluded: {len(bots)} datacenter bot, {len(autos)} known-automation, "
      f"{len(dropped)} manually dropped.\n")
    w("> `ref=internal` means a SAME-SITE referrer — someone clicking Play from the "
      "homepage. Those are real players and are counted here.\n")

    w("## Breakdown (real sessions)\n")
    w("Referrer: " + ", ".join(f"`{k}`={c}" for k, c in
                               collections.Counter(v["ref"] or "(none)" for v in real.values()).most_common()))
    w("\nDevice: " + ", ".join(f"`{k}`={c}" for k, c in
                               collections.Counter(v["dev"] or "(none)" for v in real.values()).most_common()) + "\n")

    # NEW vs RETURNING, inferred. The game does not yet emit a continue marker
    # (s:new_game_confirmed exists; s:continue_confirmed is the one section-6
    # startup event still outstanding - bead zkvy, P3), so this is a PROXY: a
    # session that reached a world scene without any new-game marker almost
    # certainly pressed Continue, i.e. it had a save from an earlier visit.
    #
    # Validated against a real case: 2026-09-15 22:37 went Title -> MainSquare
    # with NO WordsOnBlack intro, 47 min after a session that DID play the intro,
    # same browser and referrer. Skipping the intro means a save was loaded.
    #
    # It UNDERCOUNTS: a returning player who starts over looks new, and one who
    # returns on a different device has no save. Treat it as a floor.
    newish, returning = [], []
    for sid, rec in players.items():
        marks = {sc for _, sc in rec["scenes"]}
        if "m:newgame" in marks or "s:new_game_confirmed" in marks:
            newish.append(sid)
        else:
            returning.append(sid)
    w("## New vs returning (inferred)")
    w("")
    w(f"- **{len(newish)} started a new game**")
    # Split on duration. A 5-second "no new-game marker" session is far more
    # likely a reload landing mid-game (or owner testing from before IP flagging
    # existed) than a person who came back to continue. Reporting the raw count
    # as "returning players" would overstate it several-fold.
    CREDIBLE_S = 60
    cred = [k for k in returning if players[k]["dur"] >= CREDIBLE_S]
    brief = [k for k in returning if players[k]["dur"] < CREDIBLE_S]
    w(f"- **{len(returning)} reached a world scene with no new-game marker**"
      f" ({len(cred)} credible, {len(brief)} brief) - i.e. they loaded a save rather than starting over.")
    if cred:
        w(f"\n**Credible returns** (played >= {CREDIBLE_S}s):")
        for sid in sorted(cred, key=lambda k: -max(players[k]["ts"])):
            rec = players[sid]
            w(f"  - {ts_str(max(rec['ts']))} - played {fmt_dur(rec['dur'])} - {rec['dev']} - via `{rec['ref']}`")
    if brief:
        w(f"\n**Brief** (< {CREDIBLE_S}s - likely a reload landing mid-game, or owner"
          f" testing predating IP flagging; counted but not trusted):")
        for sid in sorted(brief, key=lambda k: -max(players[k]["ts"])):
            rec = players[sid]
            w(f"  - {ts_str(max(rec['ts']))} - {fmt_dur(rec['dur'])} - {rec['dev']} - via `{rec['ref']}`")
    w("")
    w("Proxy, not ground truth: it undercounts anyone who replays from scratch or returns on another device. Shipping `s:continue_confirmed` (bead zkvy) would make this exact instead of inferred.")
    w("")

    w("## Sessions that played\n")
    for sid, rec in sorted(players.items(), key=lambda kv: -max(kv[1]["ts"])):
        game = ordered(rec, True)
        flags = suspicious(rec)
        w(f"### {ts_str(max(rec['ts']))} · played {fmt_dur(rec['dur'])} · {rec['dev']} · via `{rec['ref']}`")
        if flags:
            w(f"- ⚠️ **SUSPICIOUS:** {'; '.join(flags)}")
        w(f"- session `{sid}` · beacons {dict(rec['evs'])}"
          + (f" · context `{rec['ctx']}`" if rec["ctx"] else ""))
        w(f"- **Reached:** {' → '.join(game)}\n")
    if not players:
        w("_None in this window._\n")

    w("## Arrived but never reached a game scene\n")
    last = collections.Counter()
    for rec in nonboot.values():
        seq = ordered(rec)
        last[seq[-1] if seq else "(no scene beacon at all)"] += 1
    for k, c in last.most_common():
        w(f"- `{k}` — {c} session{'s' if c != 1 else ''}")
    w("")
    for sid, rec in sorted(nonboot.items(), key=lambda kv: -max(kv[1]["ts"])):
        seq = ordered(rec)
        flags = suspicious(rec)
        w(f"- {ts_str(max(rec['ts']))} · open {fmt_dur(rec['dur'])} · {rec['dev']} · via `{rec['ref']}`"
          f" · last=`{seq[-1] if seq else 'NONE'}`"
          + (f" · ⚠️ {'; '.join(flags)}" if flags else ""))

    flagged = {k: v for k, v in real.items() if suspicious(v)}
    w(f"\n## Flagged for a human look ({len(flagged)})\n")
    if flagged:
        for sid, rec in flagged.items():
            w(f"- `{sid}` · {rec['dev']} · via `{rec['ref']}` · {'; '.join(suspicious(rec))}")
    else:
        w("_Nothing looked off._")
    w("\n---\n")
    w("Caveats: sessions are anonymous and session-scoped, so these are play "
      "SESSIONS, not unique people, and a returning player counts twice. "
      "'Never reached a game scene' can also be beacon loss (sendBeacon on a fast "
      "tab close), so treat it as directional. Owner play is NOT excluded — see "
      "the header of this script.")

    text = "\n".join(L)
    if args.out == "-":
        print(text)
        return 0
    out = args.out or os.path.join(
        "infrastructure", "reports",
        f"play-report-{dt.datetime.utcfromtimestamp(now).strftime('%Y-%m-%d')}.md")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"wrote {out} ({os.path.getsize(out)} bytes) — "
          f"{len(real)} real sessions, {len(players)} played, {fmt_dur(total_play)} total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
