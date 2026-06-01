#!/usr/bin/env bash
# staging_deploy.sh — AppC-side Godot Web export from the staging worktree.
#
# Owner: AppC (allbyte-web repo).
# Counterpart: tools/app_deploy.sh in the Chronicles repo (Arc-side, owns
#   develop branch + version bumping). This script reads the staging
#   branch state, does NOT bump WEB_VERSION (staging's version was set
#   by Arc's promote_to_staging.sh on his side), and stages the export
#   bytes into public/godot/ for subsequent push-assets.
#
# The boundary that motivates this script:
#   develop branch  - Arc iterates, bumps patch every redeploy (0.6.X)
#   staging branch  - Arc promotes deliberately, bumps minor (0.7.X+)
#   AppC reads from a dedicated worktree at ChroniclesOfNesis-staging/
#   so concurrent develop activity never races our deploy.
#
# Run inside docker:
#   docker exec --user dev tactical-dev bash /workspace/allbyte-web/scripts/staging_deploy.sh
#
# Then on host:
#   cd /c/Users/drew/Documents/GitHub/allbyte-web && npm run push-assets
#
# Exit codes:
#   0  staged successfully — run npm run push-assets next
#   1  precondition failure (missing godot, missing worktree, dirty
#      worktree, behind remote, parse failure, etc.)
#   2  Godot export silently failed (mtime guard tripped)
#   3  no new promotion since last deploy (same version) — no-op exit
#   4  post-deploy version invariant mismatch (paranoia gate)

set -euo pipefail

GAME_ROOT="/workspace/GameDev/ChroniclesOfNesis-staging"
GODOT_BIN="/workspace/GameDev/Godots/godot4"
BOOTSTRAP_PROJ="$GAME_ROOT/WebBootstrap"
BOOTSTRAP_PCK="$BOOTSTRAP_PROJ/export/index.pck"
LARIA_PROJ="$BOOTSTRAP_PROJ/packs_src/Laria"
LARIA_PCK="$BOOTSTRAP_PROJ/export/packs/Laria.pck"
COMBAT_LIB="$BOOTSTRAP_PROJ/packs_src/Combat/Combat"
SHELL_ASSETS_DIR="$BOOTSTRAP_PROJ/web_shell/assets"
WORLD_GD="$BOOTSTRAP_PROJ/Autoload/World.gd"
APP_STAGE_DIR="/workspace/allbyte-web/public/godot"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -x "$GODOT_BIN" ]      || fail "Godot binary missing or not executable: $GODOT_BIN"
[ -d "$BOOTSTRAP_PROJ" ] || fail "Staging worktree missing: $BOOTSTRAP_PROJ — run 'git worktree add ../ChroniclesOfNesis-staging staging' first"
[ -d "$LARIA_PROJ" ]     || fail "Laria pack project missing: $LARIA_PROJ"
[ -f "$WORLD_GD" ]       || fail "World.gd missing: $WORLD_GD"
[ -d "$APP_STAGE_DIR" ]  || fail "App staging dir missing: $APP_STAGE_DIR (is /workspace/allbyte-web mounted?)"

# ---------------------------------------------------------------------------
# Worktree hygiene. The boundary's whole purpose is "staging is a clean,
# reviewed source of truth." Local edits or stale remote state contradict
# that — refuse rather than ship something that doesn't match what Arc
# promoted.
# ---------------------------------------------------------------------------
cd "$GAME_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Staging worktree has uncommitted changes. Stash or revert before deploying."
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "staging" ]; then
  fail "Staging worktree is on branch '$CURRENT_BRANCH', not 'staging'. Run 'git checkout staging' in $GAME_ROOT."
fi

git fetch origin staging --quiet
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/staging)
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo ">> Staging worktree at $LOCAL_HEAD; origin/staging at $REMOTE_HEAD — pulling..."
  git pull --ff-only origin staging || fail "git pull failed (probably non-ff). Resolve manually in $GAME_ROOT."
fi

# ---------------------------------------------------------------------------
# Read staging's WEB_VERSION. We do NOT bump it — that's Arc's
# promote_to_staging.sh on the develop side.
# ---------------------------------------------------------------------------
NEW_VERSION=$(grep -oP 'WEB_VERSION := "\K[^"]+' "$WORLD_GD" || true)
[ -n "$NEW_VERSION" ] || fail "Could not parse WEB_VERSION from $WORLD_GD"
echo ">> Staging version: v$NEW_VERSION"

# ---------------------------------------------------------------------------
# No-op short-circuit: if the last deployed version matches the current
# staging version, there's nothing to do. Lets accidental re-runs of this
# script be cheap and prevents needlessly bumping the SW cache name for
# zero content change.
# ---------------------------------------------------------------------------
LAST_DEPLOYED=""
if [ -f "$APP_STAGE_DIR/test_results/current_version.txt" ]; then
  LAST_DEPLOYED=$(grep -oP '^version:\s*\K\S+' "$APP_STAGE_DIR/test_results/current_version.txt" 2>/dev/null || true)
fi
if [ "$LAST_DEPLOYED" = "$NEW_VERSION" ]; then
  echo "No new promotion since last deploy (both at v$NEW_VERSION). Nothing to stage."
  exit 3
fi

# ---------------------------------------------------------------------------
# Helper: run a Godot export and verify the output pck mtime actually
# changed. Mirrors Arc's run_export_or_die — Godot 4 will exit 0 on
# preset-name mismatches and leave the pck stale; mtime guard is what
# catches that.
# ---------------------------------------------------------------------------
run_export_or_die() {
  local label="$1"; shift
  local pre_mtime="$1"; shift
  local out_pck="$1"; shift

  local log
  log=$(mktemp)
  echo ">> Exporting $label..."
  if ! DISPLAY=:99 "$GODOT_BIN" --headless "$@" >"$log" 2>&1; then
    echo "ERROR: $label export exited non-zero." >&2
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  tail -3 "$log" || true

  local post_mtime=0
  [ -f "$out_pck" ] && post_mtime=$(stat -c%Y "$out_pck")

  if [ "$post_mtime" = "$pre_mtime" ]; then
    echo "" >&2
    echo "============================================================" >&2
    echo "ERROR: $label export SILENTLY FAILED." >&2
    echo "  $out_pck mtime unchanged ($pre_mtime)." >&2
    echo "  Common cause: preset name mismatch or pack project on a" >&2
    echo "  different Godot major version. See Arc's tools/redeploy_web.sh" >&2
    echo "  header for full failure-mode catalogue." >&2
    echo "------------ full Godot output: ----------------------------" >&2
    cat "$log" >&2
    echo "============================================================" >&2
    rm -f "$log"
    return 2
  fi

  rm -f "$log"
  echo ">> $label export OK (mtime $pre_mtime -> $post_mtime)"
}

sync_combat_into_zone() {
  local zone_dir="$1"
  local dst="$zone_dir/Combat"
  echo ">> Syncing combat library into $dst/"
  rm -rf "$dst"
  cp -a "$COMBAT_LIB" "$dst"
  rm -rf "$zone_dir/.godot/exported"

  local COMBAT_GUI_DEPS=(
    "GUI/Fonts/ModernGoth.otf"
    "GUI/Assets/old_paper_paper_modified2.PNG"
    "GUI/Assets/BorderBlock_Simple_Raised2.png"
  )
  for dep in "${COMBAT_GUI_DEPS[@]}"; do
    local src_file="$BOOTSTRAP_PROJ/$dep"
    local dst_file="$zone_dir/$dep"
    if [ -f "$src_file" ]; then
      mkdir -p "$(dirname "$dst_file")"
      cp -a "$src_file" "$dst_file"
      [ -f "${src_file}.import" ] && cp -a "${src_file}.import" "${dst_file}.import"
    else
      echo "WARNING: combat GUI dep missing from staging: $dep" >&2
    fi
  done
}

# ---------------------------------------------------------------------------
# Capture pre-export mtimes for silent-failure guard.
# ---------------------------------------------------------------------------
BOOTSTRAP_PRE=0
[ -f "$BOOTSTRAP_PCK" ] && BOOTSTRAP_PRE=$(stat -c%Y "$BOOTSTRAP_PCK")
LARIA_PRE=0
[ -f "$LARIA_PCK" ] && LARIA_PRE=$(stat -c%Y "$LARIA_PCK")

# ---------------------------------------------------------------------------
# Bootstrap export (HARD requirement).
# ---------------------------------------------------------------------------
run_export_or_die "bootstrap (Web)" "$BOOTSTRAP_PRE" "$BOOTSTRAP_PCK" \
  --path "$BOOTSTRAP_PROJ" \
  --export-release "Web" \
  "$BOOTSTRAP_PROJ/export/index.html"

# ---------------------------------------------------------------------------
# Laria pack export (SOFT step — failure keeps prior bytes + warns).
# ---------------------------------------------------------------------------
if [ "${SKIP_PACK_REBUILD:-0}" = "1" ]; then
  echo ">> Skipping Laria pack rebuild (SKIP_PACK_REBUILD=1)."
else
  if [ -d "$COMBAT_LIB" ]; then
    sync_combat_into_zone "$LARIA_PROJ"
  else
    echo "WARNING: combat library missing at $COMBAT_LIB — proceeding without inject." >&2
  fi
  if run_export_or_die "Laria pack" "$LARIA_PRE" "$LARIA_PCK" \
       --path "$LARIA_PROJ" \
       --export-pack "Pack" "$LARIA_PCK"; then
    :
  else
    echo "" >&2
    echo "WARNING: Laria pack rebuild failed. Continuing with the existing" >&2
    echo "  pack at $LARIA_PCK (deployed bytes will be unchanged)." >&2
    echo "" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Stage into /workspace/allbyte-web/public/godot/.
# ---------------------------------------------------------------------------
mkdir -p "$APP_STAGE_DIR/packs"
cp "$BOOTSTRAP_PROJ"/export/index.* "$APP_STAGE_DIR/"
if [ -f "$LARIA_PCK" ]; then
  cp "$LARIA_PCK" "$APP_STAGE_DIR/packs/Laria.pck"
fi
rm -f "$APP_STAGE_DIR/packs/LariaVillage.pck" \
      "$APP_STAGE_DIR/packs/LariaWaterways.pck" \
      "$APP_STAGE_DIR/packs/Combat.pck"

if [ -d "$SHELL_ASSETS_DIR" ]; then
  cp "$SHELL_ASSETS_DIR"/loading-icon.png        "$APP_STAGE_DIR/" 2>/dev/null || true
  cp "$SHELL_ASSETS_DIR"/moderngoth-subset.woff2 "$APP_STAGE_DIR/" 2>/dev/null || true
  cp "$SHELL_ASSETS_DIR"/moderngoth-subset.woff  "$APP_STAGE_DIR/" 2>/dev/null || true
  echo ">> Copied Chronicles boot shell assets to $APP_STAGE_DIR/"
else
  echo "WARNING: $SHELL_ASSETS_DIR missing — boot shell will fall back to system fonts." >&2
fi

# Patch HTML: canvas right-click + cache-busters + Cache-Control meta.
HTML="$APP_STAGE_DIR/index.html"
sed -i "s/<canvas id='canvas'>/<canvas id='canvas' oncontextmenu='event.preventDefault();'>/" "$HTML"
sed -i "s/<canvas id=\"canvas\">/<canvas id=\"canvas\" oncontextmenu=\"event.preventDefault();\">/" "$HTML"

if ! grep -q 'Cache-Control.*no-store' "$HTML"; then
  if grep -q '<meta charset="utf-8">' "$HTML"; then
    sed -i 's|<meta charset="utf-8">|<meta charset="utf-8">\n\t\t<meta http-equiv="Cache-Control" content="no-store">\n\t\t<meta http-equiv="Pragma" content="no-cache">|' "$HTML"
  else
    sed -i "s|<meta charset='utf-8' />|<meta charset='utf-8' />\n\t<meta http-equiv='Cache-Control' content='no-store' />\n\t<meta http-equiv='Pragma' content='no-cache' />|" "$HTML"
  fi
fi
sed -i "s|src='index\\.js[^']*'|src='index.js?v=$NEW_VERSION'|" "$HTML"
sed -i "s|src=\"index\\.js[^\"]*\"|src=\"index.js?v=$NEW_VERSION\"|" "$HTML"
sed -i "s|index\\.pck|index.pck?v=$NEW_VERSION|g" "$HTML"
sed -i "s|index\\.wasm|index.wasm?v=$NEW_VERSION|g" "$HTML"

# ---------------------------------------------------------------------------
# In-staging version stamp. The auto-reload script in index.html polls
# this. Same path Arc's app_deploy.sh used so any client-side polling
# code keeps working.
# ---------------------------------------------------------------------------
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
INDEX_PCK_BYTES=$(stat -c%s "$APP_STAGE_DIR/index.pck")
LARIA_PCK_BYTES=$(stat -c%s "$APP_STAGE_DIR/packs/Laria.pck" 2>/dev/null || echo 0)
mkdir -p "$APP_STAGE_DIR/test_results"
cat > "$APP_STAGE_DIR/test_results/current_version.txt" <<EOF
version: $NEW_VERSION
deployed_at: $TIMESTAMP
index_pck_bytes: $INDEX_PCK_BYTES
laria_pck_bytes: $LARIA_PCK_BYTES
EOF

# ---------------------------------------------------------------------------
# Paranoia gate: the staging World.gd value should still match
# current_version.txt. (If git pull mid-script changed World.gd somehow,
# this catches it.)
# ---------------------------------------------------------------------------
DEPLOYED_PCK_VERSION=$(grep -oP 'WEB_VERSION := "\K[^"]+' "$WORLD_GD")
if [ "$DEPLOYED_PCK_VERSION" != "$NEW_VERSION" ]; then
  echo "ERROR: post-deploy World.gd=$DEPLOYED_PCK_VERSION but expected $NEW_VERSION" >&2
  exit 4
fi

echo ""
echo "============================================================"
echo "Staged Chronicles of Nesis web build for AppC (from staging)."
echo "  branch:        staging @ $LOCAL_HEAD"
echo "  version:       v$NEW_VERSION"
echo "  staged at:     $APP_STAGE_DIR"
echo "  index.pck:     $INDEX_PCK_BYTES bytes"
echo "  Laria.pck:     $LARIA_PCK_BYTES bytes"
echo "  deployed_at:   $TIMESTAMP"
echo ""
echo "NEXT STEP — on the host:"
echo "  cd /c/Users/drew/Documents/GitHub/allbyte-web && npm run push-assets"
echo "============================================================"
