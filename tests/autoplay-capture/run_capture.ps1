# Autoplay capture orchestrator — Windows native.
#
# Replaces the Docker-based pipeline. Captures at the host's GPU rate
# (60fps with hardware accel) instead of the container's Mesa software
# renderer (~10fps).
#
# Sequence:
#   1. Generate per-run capture name + paths
#   2. Start ffmpeg recording the desktop (gdigrab)
#   3. Run run.py — launches Playwright Chromium on the host, drives
#      autoplay against /play/, samples per-second fps via rAF probe
#   4. Send 'q' to ffmpeg stdin → graceful MP4 finalize
#   5. Run clip_extractor.py → MP4 clips + thumbnails
#   6. Run caption_drafter.py → Claude CLI captions (skips if no CLI)
#   7. Run upload_to_s3.py → S3 + invalidation
#
# Prerequisites (one-time host install):
#   - ffmpeg in PATH (winget install Gyan.FFmpeg)
#   - python 3.10+ with: pip install playwright boto3 anthropic
#   - playwright install chromium
#   - AWS creds in ~/.aws/credentials (existing)
#   - claude CLI on PATH (already present for this session)
#
# Audio setup (one-time, optional but recommended):
#   Game audio is captured from a VB-Audio Virtual Cable. To route Chromium's
#   output to the cable so it's the only thing recorded:
#     1. Right-click the speaker icon -> Open Sound settings
#     2. Scroll to "Advanced sound options" -> "App volume and device preferences"
#     3. Find the entry for Chromium (will appear after the first capture run)
#     4. Output -> "CABLE Input (VB-Audio Virtual Cable)"
#   After this, your speakers stay silent during capture (Chromium plays only
#   to the cable). Pass -NoAudio to skip audio capture entirely.
#
# Override defaults via parameters or env vars:
#   ./run_capture.ps1 -DurationS 300 -Persona scout
#   ./run_capture.ps1 -NoAudio
#   $env:SAVE_FIXTURE_URL = "..."; ./run_capture.ps1

[CmdletBinding()]
param(
    [int]$DurationS = $(if ($env:DURATION_S) { [int]$env:DURATION_S } else { 180 }),
    [string]$Persona = $(if ($env:PERSONA) { $env:PERSONA } else { "default" }),
    [string]$TargetUrl = $(if ($env:TARGET_URL) { $env:TARGET_URL } else { "http://localhost:4321/play/" }),
    [string]$SaveFixtureUrl = $(if ($env:SAVE_FIXTURE_URL) { $env:SAVE_FIXTURE_URL } else { "http://localhost:4321/test-data/WebTests/fixtures/saves/frontier/cond_11_waterway1_entry.json" }),
    [string]$OutDir = $(if ($env:OUT_DIR) { $env:OUT_DIR } else { ".tmp/capture-out" }),
    [int]$VideoWidth = 1920,
    [int]$VideoHeight = 1080,
    [int]$Framerate = 60,
    [string]$AudioDevice = $(if ($env:AUDIO_DEVICE) { $env:AUDIO_DEVICE } else { "CABLE Output (VB-Audio Virtual Cable)" }),
    [switch]$NoAudio,
    # -Headless runs Chromium without a visible window and captures via
    # the Chrome DevTools Protocol's Page.startScreencast (no gdigrab).
    # Use this for batch / unattended captures that shouldn't disrupt
    # the desktop. Audio capture is intentionally skipped in headless —
    # the visible mode is the path for marketing-grade audio.
    [switch]$Headless,
    # -TitleScreen captures the Title screen itself (with music) as a single
    # whole-clip marketing showcase — no autoplay, no save fixture. Defaults
    # to a 30s hold. The entire recording becomes one clip in the marketing
    # queue (clip_extractor whole-clip mode).
    [switch]$TitleScreen,
    # -NoUpload keeps the capture local (skips the S3 push) so it stays a
    # draft reviewable at the dev console's /test/marketing-queue/.
    [switch]$NoUpload
)

$ErrorActionPreference = "Stop"
# Force Python stdout/stderr to UTF-8 so subprocess prints don't crash
# on cp1252's missing chars (arrows, em-dashes, etc.). PowerShell 5.1
# defaults to cp1252 for redirected pipes; UTF-8 dodges that entirely.
$env:PYTHONIOENCODING = "utf-8"

# --- Preflight -------------------------------------------------------------
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $repoRoot

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    throw "ffmpeg not in PATH. Install via: winget install Gyan.FFmpeg"
}
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw "python not in PATH. Install Python 3.10+ and retry."
}

$outDirAbs = Join-Path $repoRoot $OutDir
if (-not (Test-Path $outDirAbs)) {
    New-Item -ItemType Directory -Path $outDirAbs -Force | Out-Null
}

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$captureName = "capture_$ts"
$mp4Path = Join-Path $outDirAbs "$captureName.mp4"
$timelinePath = Join-Path $outDirAbs "$captureName.timeline.json"

# Title-screen showcase mode: hold on Title with music, emit the whole
# recording as one clip. No autoplay, no save fixture.
$Mode = "autoplay"
if ($TitleScreen) {
    $Mode = "title"
    $SaveFixtureUrl = ""
    if (-not $PSBoundParameters.ContainsKey('DurationS')) { $DurationS = 30 }
    $env:CAPTURE_WHOLE_CLIP = "1"
    $env:CAPTURE_CLIP_LABEL = "title-screen"
} else {
    $env:CAPTURE_WHOLE_CLIP = ""
}

Write-Host "[capture] session=$captureName"
Write-Host "[capture] mode=$Mode target=$TargetUrl persona=$Persona duration=${DurationS}s"

# Pass capture params via env so run.py can manage ffmpeg lifecycle
# itself — it knows when Chromium's window exists with the right title,
# so it can launch ffmpeg with -i title= mode and find the window
# regardless of which monitor it lands on.
$env:MP4_PATH = $mp4Path
$env:TIMELINE_PATH = $timelinePath
$env:CLIPS_DIR = Join-Path $outDirAbs "clips"
$env:CAPTURE_FRAMERATE = "$Framerate"
if ($Headless) {
    Write-Host "[capture] mode: headless (no visible window; CDP screencast)"
    $env:CAPTURE_HEADLESS = "1"
    # Audio capture isn't supported in headless mode — Chromium routes
    # to a null sink and there's no window to attach dshow to. Force
    # NoAudio so the audio device env doesn't get set.
    $NoAudio = $true
} else {
    $env:CAPTURE_HEADLESS = "0"
}
if ($NoAudio) {
    $env:CAPTURE_AUDIO_DEVICE = ""
} else {
    Write-Host "[capture] audio device: $AudioDevice"
    $env:CAPTURE_AUDIO_DEVICE = $AudioDevice
}

try {
    # --- Run the Playwright harness (manages ffmpeg internally) -----------
    $runPy = Join-Path $repoRoot "tests\autoplay-capture\run.py"
    # NOTE: --opt=value form is deliberate. PowerShell 5.1 silently DROPS
    # empty-string arguments to native commands, so `--save-fixture-url ""`
    # would lose its value and argparse would consume the next flag as the
    # URL. The single-token `--save-fixture-url=` survives and argparse reads
    # it as an empty string → run.py dismisses the Title and starts a new
    # game from the beginning. This is the only way to request a from-start
    # capture through the wrapper.
    & python $runPy "--target-url=$TargetUrl" "--save-fixture-url=$SaveFixtureUrl" "--persona=$Persona" "--duration=$DurationS" "--mode=$Mode"
    $runExit = $LASTEXITCODE
    Write-Host "[capture] run.py exit=$runExit"
} finally {
    # run.py owns ffmpeg lifecycle; if it crashed mid-capture, any
    # orphan ffmpeg processes will exit when their stdin pipe closes
    # because the parent (python) is gone. No PowerShell cleanup needed
    # in the normal path.
}

# --- Clip extraction -------------------------------------------------------
Write-Host "[capture] extracting clips"
& python (Join-Path $repoRoot "tests\autoplay-capture\clip_extractor.py")

# --- Still extraction ------------------------------------------------------
# Pulls scene-entry + combat-mid + hero frames from the MP4 for
# walkthrough review and marketing stills.
$env:STILLS_DIR = Join-Path $outDirAbs "stills"
Write-Host "[capture] extracting stills"
& python (Join-Path $repoRoot "tests\autoplay-capture\screenshot_extractor.py")

# --- Chapter aggregation ---------------------------------------------------
# Aggregates timeline events + clip refs into walkthrough-shaped JSON.
# Mostly-empty fields until Arc lands Completionist + walk-* emits — runs
# regardless so the structure exists.
Write-Host "[capture] aggregating chapter"
& python (Join-Path $repoRoot "tests\autoplay-capture\chapter_extractor.py")

# --- Caption drafting (skips cleanly if no claude CLI / no API key) -------
Write-Host "[capture] drafting captions"
& python (Join-Path $repoRoot "tests\autoplay-capture\caption_drafter.py")

# --- S3 upload (skips cleanly if no AWS creds) ----------------------------
if ($NoUpload) {
    Write-Host "[capture] skipping S3 upload (-NoUpload) - review locally at /test/marketing-queue/"
} else {
    Write-Host "[capture] uploading to S3"
    & python (Join-Path $repoRoot "tests\autoplay-capture\upload_to_s3.py")
}

Write-Host "[capture] done - MP4 at $mp4Path"
