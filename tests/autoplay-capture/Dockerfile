# Autoplay capture harness — see APP_CLAUDE_AUTOPLAY_CAPTURE_PROTOCOL_REPLY.md.
#
# Architecture (Path B, owner-confirmed 2026-06-04):
#   Xvfb -> headed Chromium -> PulseAudio (null-sink -> monitor source)
#                  |                        |
#                  +---- ffmpeg ------------+
#                              |
#                              v
#                    autoplay.mp4 (video + audio muxed)
#
# Playwright drives the browser via DISPLAY=:99. ffmpeg captures the
# X11 framebuffer + Pulse monitor source and muxes both into a single
# MP4 file. We don't use Playwright's record_video_dir because it's
# video-only (Arc validated this empirically; see Q5 in the protocol
# reply doc).
#
# Built but not yet integrated — waiting on Arc's Phase 1 protocol
# contract commit before the harness orchestrator (run.py) can send
# the autoplay-capture-* messages.

FROM mcr.microsoft.com/playwright/python:v1.58.0-noble

# Install the audio + video capture stack on top of the Playwright base.
# pulseaudio: virtual sound server with null-sink + monitor pattern that
#   gives ffmpeg something to tap. Chromium plays out to PulseAudio's
#   default sink, which is wired as a null-sink so nothing leaves the
#   container, but the sink's monitor source is what ffmpeg reads.
# ffmpeg: the muxer. x11grab for video, pulse for audio, libx264 + aac
#   for the encoded MP4.
# xvfb: virtual framebuffer X server. Playwright base includes it but
#   we install explicitly for hygiene.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pulseaudio \
        pulseaudio-utils \
        ffmpeg \
        xvfb \
        x11-utils \
        libgl1-mesa-dri \
        libglx-mesa0 \
    && rm -rf /var/lib/apt/lists/*

# Force Mesa's software (llvmpipe) WebGL driver. Xvfb has no GPU, so we
# need software rasterization for WebGL2 — Godot's web shell refuses to
# boot without it. Mesa's llvmpipe is CPU-only and matches the Playwright
# base image's GL surface. SwiftShader would be cleaner but isn't bundled
# with the v1.58 Playwright image.
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV GALLIUM_DRIVER=llvmpipe

# Run as a non-root user. PulseAudio refuses to start as root by default
# and the Playwright base image expects user-mode operation anyway.
# `pwuser` is the user the Playwright base ships with.
USER pwuser
WORKDIR /home/pwuser/harness

# Python deps for the harness. Pinned loosely — Playwright is already
# baked into the base image, we only need its Python wrapper hooks and
# anything for our orchestration code.
COPY --chown=pwuser:pwuser requirements.txt /home/pwuser/harness/requirements.txt
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=pwuser:pwuser . /home/pwuser/harness/

# boot.sh sequences Xvfb -> PulseAudio -> ffmpeg -> run.py and traps cleanup
# on exit so ffmpeg finalizes the MP4 cleanly. run.py is the Playwright
# orchestrator that drives the AutoPlay surface.
#
# Outputs land in /home/pwuser/out/ (bind-mount this to grab the artifacts):
#   docker run --rm \
#     -v $(pwd)/out:/home/pwuser/out \
#     --add-host=host.docker.internal:host-gateway \
#     allbyte/autoplay-capture
#
# Override defaults via env:
#   TARGET_URL, FIXTURE_PATH, PERSONA, DURATION_S, STARTUP_SKIP_S
ENTRYPOINT ["bash", "/home/pwuser/harness/boot.sh"]
