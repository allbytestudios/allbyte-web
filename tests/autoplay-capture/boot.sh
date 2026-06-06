#!/usr/bin/env bash
# Startup sequencer for the autoplay-capture container.
#
# Order matters:
#   1. Xvfb     — virtual display, must be up before Chromium tries to attach
#   2. Pulse    — must be up before Chromium opens its audio output
#   3. ffmpeg   — backgrounded; muxes x11grab :99 + pulse monitor → MP4
#   4. run.py   — Playwright orchestrator runs the actual capture session
#   5. cleanup  — SIGTERM ffmpeg so it finalizes the MP4 cleanly; reap Xvfb + Pulse
#
# Output paths are passed via env so the harness can be driven without
# editing this script:
#   OUT_DIR         — where MP4 + timeline.json land (default: /home/pwuser/out)
#   CAPTURE_NAME    — base filename for this run (default: capture_<timestamp>)

set -euo pipefail

OUT_DIR="${OUT_DIR:-/home/pwuser/out}"
CAPTURE_NAME="${CAPTURE_NAME:-capture_$(date -u +%Y%m%dT%H%M%SZ)}"
DISPLAY=":99"
# Smaller viewport gives the Mesa software rasterizer ~9x less pixels to
# fill per frame. At 1920x1080 the game renders at ~1fps, unwatchable.
# Override via env if you need higher resolution for marketing-grade
# stills, but expect a proportional fps hit.
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1280x720x24}"

mkdir -p "$OUT_DIR"
MP4_PATH="$OUT_DIR/${CAPTURE_NAME}.mp4"
TIMELINE_PATH="$OUT_DIR/${CAPTURE_NAME}.timeline.json"
export MP4_PATH TIMELINE_PATH

# --- Xvfb -------------------------------------------------------------------
echo "[boot] starting Xvfb on $DISPLAY ($SCREEN_GEOMETRY)"
Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp &
XVFB_PID=$!
export DISPLAY

# Block until the X server is accepting connections. xdpyinfo exits 0 once
# the display is reachable. ~3s upper bound on a healthy boot.
for i in {1..30}; do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        echo "[boot] Xvfb ready (pid=$XVFB_PID)"
        break
    fi
    sleep 0.1
done

# --- PulseAudio -------------------------------------------------------------
# null-sink + monitor source pattern. Chromium plays out to the default sink
# (which is the null-sink — no host speakers), and ffmpeg reads from the
# monitor of that sink to capture the audio stream.
echo "[boot] starting PulseAudio with null-sink"
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=captureSink sink_properties=device.description=captureSink >/dev/null
pactl set-default-sink captureSink

# --- ffmpeg recording -------------------------------------------------------
echo "[boot] starting ffmpeg → $MP4_PATH"
# x11grab framerate 60 to catch battle-transition wipes and animation
# frames that 30fps was dropping. Capture rate is independent of Godot's
# actual render rate — if the game runs at 30fps internally, x11grab
# captures every frame Xvfb displays (no duplicates added).
# -loglevel info (not error) so capture failures surface in boot logs.
ffmpeg -hide_banner -loglevel info \
    -f x11grab -framerate 60 \
    -video_size "${SCREEN_GEOMETRY%x*}" -i "$DISPLAY" \
    -f pulse -i captureSink.monitor \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    -y "$MP4_PATH" 2>>/home/pwuser/out/ffmpeg.log &
FFMPEG_PID=$!
echo "[boot] ffmpeg pid=$FFMPEG_PID"

# Trap to terminate ffmpeg cleanly. SIGINT (not SIGKILL) so ffmpeg writes
# its moov atom and the MP4 is playable.
cleanup() {
    echo "[boot] cleanup: stopping ffmpeg, Pulse, Xvfb"
    kill -INT "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
    pulseaudio --kill 2>/dev/null || true
    kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Playwright harness -----------------------------------------------------
echo "[boot] handing off to run.py"
# Disable errexit around the harness call so a Playwright failure doesn't
# skip the clip-extraction step (we still want clips from any usable
# fragment of the recording).
set +e
python3 /home/pwuser/harness/run.py "$@"
RUN_EXIT=$?
set -e

# Stop ffmpeg cleanly so the MP4 finalizes before clip extraction reads it.
# (The trap will fire on script exit anyway, but we need ffmpeg finalized
# *before* clip_extractor.py runs.)
echo "[boot] stopping ffmpeg to finalize MP4"
kill -INT "$FFMPEG_PID" 2>/dev/null || true
wait "$FFMPEG_PID" 2>/dev/null || true

# --- Clip extraction --------------------------------------------------------
# Reads MP4_PATH + TIMELINE_PATH (set above), groups combat events into
# clusters, cuts per-cluster clips with lead/lag padding, writes thumbnails.
# Failure here is non-fatal — the raw capture is still usable.
echo "[boot] extracting clips"
python3 /home/pwuser/harness/clip_extractor.py || echo "[boot] clip extraction failed (non-fatal)"

# Caption drafting is intentionally NOT chained here — it runs on the
# HOST (where the `claude` CLI binary + auth state live), triggered from
# the marketing-queue UI's "Draft captions" button. Container has no
# claude binary, no Max-subscription auth. SDK fallback exists if you
# want headless captioning later (CAPTION_BACKEND=sdk + ANTHROPIC_API_KEY).

# --- S3 upload (optional, gated on AWS credentials presence) ---------------
# Uploads clips + manifest + full-session MP4 + timeline to
# s3://allbyte.studio-site/captures/latest/ so the marketing-queue UI can
# read from CloudFront in prod. Smoke-test container has no creds and
# skips cleanly.
echo "[boot] uploading to S3"
python3 /home/pwuser/harness/upload_to_s3.py || echo "[boot] S3 upload failed (non-fatal)"

exit $RUN_EXIT
