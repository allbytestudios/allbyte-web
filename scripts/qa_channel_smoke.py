"""CI channel smoke — verify every runtime-published game channel.

Fetches the live /godot/channels.json (the runtime availability the deploy
pipeline self-publishes) and runs the appropriate smoke per channel:

  open channels (develop, beta-debug, and the alpha pair if listed)
      → boot-only smoke (top-level load, engine reaches a scene)
  gated channels (beta)
      → locked-only smoke (anonymous access must be refused). CI holds no
        user JWTs, so the entitled cookie-boot half runs only in the
        owner-run promote smoke (push-channel → smoke_prod --channel beta).

Reuses scripts/smoke_prod.py directly (same channel map, same checks), so CI
and the deploy-time smoke can never disagree.

Writes <out>/results.json:
  { "checkedAt": ..., "origin": ..., "channels": { "<id>": "pass"|"fail" } }

Env:
  SMOKE_ORIGIN       site origin (default https://allbyte.studio)
  CHANNEL_SMOKE_OUT  output dir (default channel-smoke/)

Exit codes: 0 = every published channel passed (or none published), 1 = any failed.
"""

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smoke_prod  # noqa: E402

ORIGIN = os.environ.get("SMOKE_ORIGIN", "https://allbyte.studio")
OUT_DIR = os.environ.get("CHANNEL_SMOKE_OUT", "channel-smoke")


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    url = f"{ORIGIN}/godot/channels.json?cb={int(time.time())}"
    try:
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        channels = json.loads(urllib.request.urlopen(req, timeout=15).read())
    except Exception as e:
        print(f"[channel-smoke] channels.json not readable ({e}) — nothing published, nothing to smoke")
        channels = {}

    results = {
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "origin": ORIGIN,
        "channels": {},
    }
    known = smoke_prod.channel_paths()
    failed = False
    for ch in sorted(channels):
        if ch not in known:
            print(f"[channel-smoke] '{ch}' in channels.json is not in gameVersions.ts — flagging")
            results["channels"][ch] = "fail"
            failed = True
            continue
        gated = ch in smoke_prod.GATED_CHANNELS
        print(f"\n[channel-smoke] === {ch} ({'locked-only' if gated else 'boot-only'}) ===")
        code = smoke_prod.run_channel_smoke(
            ch, ORIGIN, boot_only=not gated, locked_only=gated
        )
        results["channels"][ch] = "pass" if code == 0 else "fail"
        failed = failed or code != 0

    with open(os.path.join(OUT_DIR, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\n[channel-smoke] {results['channels'] or 'no channels published'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
