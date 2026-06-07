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
    [switch]$NoAudio
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

Write-Host "[capture] session=$captureName"
Write-Host "[capture] target=$TargetUrl persona=$Persona duration=${DurationS}s"

# --- Start ffmpeg (background) ---------------------------------------------
# gdigrab captures the desktop at the requested size/offset. We capture
# only the top-left WxH region so Chromium maximized at that size fills
# it exactly. Audio capture is intentionally omitted in v1 — wiring
# dshow requires a Stereo-Mix or virtual-audio-capturer driver that
# isn't universally available. Captions can fill the narrative gap.
Write-Host "[capture] starting ffmpeg -> $mp4Path"
# PowerShell 5.1 ProcessStartInfo uses Arguments (single string), not
# ArgumentList. Build it with all args quoted so paths-with-spaces work.
# Video: gdigrab top-left WxH region. Audio: dshow from the configured
# device (typically the recording side of a VB-Audio Virtual Cable).
$ffmpegArgs = [System.Collections.Generic.List[string]]::new()
$ffmpegArgs.AddRange([string[]]@(
    "-hide_banner", "-loglevel", "warning",
    "-f", "gdigrab",
    "-framerate", "$Framerate",
    "-video_size", "${VideoWidth}x${VideoHeight}",
    "-offset_x", "0", "-offset_y", "0",
    "-draw_mouse", "0",
    "-i", "desktop"
))
if (-not $NoAudio) {
    Write-Host "[capture] audio device: $AudioDevice"
    $ffmpegArgs.AddRange([string[]]@(
        "-f", "dshow",
        "-i", "`"audio=$AudioDevice`""
    ))
}
$ffmpegArgs.AddRange([string[]]@(
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"
))
if (-not $NoAudio) {
    $ffmpegArgs.AddRange([string[]]@("-c:a", "aac", "-b:a", "192k"))
}
$ffmpegArgs.AddRange([string[]]@("-y", "`"$mp4Path`""))
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "ffmpeg"
$psi.Arguments = ($ffmpegArgs -join " ")
$psi.RedirectStandardInput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$ffmpegProc = [System.Diagnostics.Process]::Start($psi)
if (-not $ffmpegProc) {
    throw "Failed to start ffmpeg (check `$psi`)."
}

# Give ffmpeg ~1s to actually start recording before launching Chromium.
Start-Sleep -Milliseconds 1000

try {
    # --- Run the Playwright harness ----------------------------------------
    $env:MP4_PATH = $mp4Path
    $env:TIMELINE_PATH = $timelinePath
    $env:CLIPS_DIR = Join-Path $outDirAbs "clips"

    $runPy = Join-Path $repoRoot "tests\autoplay-capture\run.py"
    & python $runPy --target-url $TargetUrl --save-fixture-url $SaveFixtureUrl --persona $Persona --duration $DurationS
    $runExit = $LASTEXITCODE
    Write-Host "[capture] run.py exit=$runExit"
} finally {
    # --- Stop ffmpeg gracefully (send 'q' to stdin) -----------------------
    if (-not $ffmpegProc.HasExited) {
        Write-Host "[capture] stopping ffmpeg (graceful 'q')"
        try {
            $ffmpegProc.StandardInput.Write("q")
            $ffmpegProc.StandardInput.Flush()
        } catch {}
        # Wait up to 8s for MP4 finalize. Force-kill if it hangs.
        if (-not $ffmpegProc.WaitForExit(8000)) {
            Write-Host "[capture] ffmpeg didn't exit on q; killing"
            $ffmpegProc.Kill()
            $ffmpegProc.WaitForExit(2000) | Out-Null
        }
    }
    Write-Host "[capture] ffmpeg final exit=$($ffmpegProc.ExitCode)"
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
Write-Host "[capture] uploading to S3"
& python (Join-Path $repoRoot "tests\autoplay-capture\upload_to_s3.py")

Write-Host "[capture] done - MP4 at $mp4Path"
