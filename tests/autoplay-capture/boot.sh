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
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"

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
# x11grab framerate=30 matches the Godot game's render cadence; bumping
# higher just doubles file size. -loglevel error keeps the harness output
# readable; ffmpeg is chatty by default.
ffmpeg -hide_banner -loglevel error \
    -f x11grab -framerate 30 -video_size "${SCREEN_GEOMETRY%x*}" -i "$DISPLAY" \
    -f pulse -i captureSink.monitor \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    -y "$MP4_PATH" &
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

exit $RUN_EXIT
