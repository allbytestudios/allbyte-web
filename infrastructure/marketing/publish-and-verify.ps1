# Robust Postiz publisher: create -> verify PUBLISHED -> self-heal if the
# Temporal worker is wedged. Use this instead of raw `postiz posts:create`.
#
# Why this exists: on 2026-06-30 the orchestrator's Temporal worker silently
# stopped polling after idle days, leaving posts stuck in QUEUE forever while
# pm2 reported it "online". `posts:create` says "created" but the post never
# publishes. This wrapper verifies the post actually goes PUBLISHED, and if it
# stalls it does a clean `docker restart` (which preserves the ts.net cookie
# patch) and re-verifies. See memory: project_postiz_publish_heal.
#
# Usage (single post):
#   ./publish-and-verify.ps1 -IntegrationId <id> -Content "text" `
#       [-Media https://...] [-Settings '{"channel":"123","__type":"discord"}']
# Health-check only (no post - just heal a wedged worker if posts are stuck):
#   ./publish-and-verify.ps1 -HealOnly
#
# Discord needs -Settings {channel,__type:discord}. Bluesky max 300 graphemes.

param(
  [string]$IntegrationId,
  [string]$Content,
  [string]$Media,
  [string]$Settings,
  [switch]$HealOnly,
  [int]$VerifyTimeoutSec = 120,
  [int]$ScheduleOffsetMin = 1
)

$ErrorActionPreference = "Stop"
$wrapper   = Join-Path $PSScriptRoot "postiz.ps1"
$Container = "allbyte-marketing-postiz"
$PG = "allbyte-marketing-postgres"; $U = "postiz-user"; $D = "postiz-db-local"

function Get-PostState([string]$id) {
  $s = docker exec $PG psql -U $U -d $D -t -A -c "SELECT \`"state\`" FROM \`"Post\`" WHERE id='$id';" 2>$null
  return ($s | Out-String).Trim()
}

# Count posts stuck in QUEUE past their scheduled publish time (the wedged-worker signal).
function Get-StuckCount {
  $n = docker exec $PG psql -U $U -d $D -t -A -c "SELECT count(*) FROM \`"Post\`" WHERE \`"state\`"='QUEUE' AND \`"publishDate\`" < now() - interval '2 minutes' AND \`"deletedAt\`" IS NULL;" 2>$null
  return [int](($n | Out-String).Trim())
}

function Restart-Postiz {
  Write-Host "  -> worker looks wedged; docker restart $Container (preserves cookie patch, ~1-2 min)..."
  docker restart $Container | Out-Null
  Start-Sleep -Seconds 45   # pm2 boot + webpack workflow-bundle rebuild + 'main' worker RUNNING
}

function New-Post([string]$content, [string]$integrationId, [string]$media, [string]$settings) {
  $date = [DateTime]::UtcNow.AddMinutes($ScheduleOffsetMin).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $a = @("posts:create", "--content", $content, "--date", $date, "--integrations", $integrationId, "--type", "schedule")
  if ($media)    { $a += @("--media", $media) }
  if ($settings) { $a += @("--settings", ($settings -replace '"', '\"')) }  # escape so quotes survive `& postiz`
  $out = & $wrapper @a 2>&1 | Out-String
  if ($out -match '"postId":\s*"([^"]+)"') { return $Matches[1] }
  throw "posts:create failed:`n$out"
}

# Wait for a post to reach PUBLISHED, healing once if it stalls.
function Wait-Published([string]$id) {
  $deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
  $healed = $false
  while ((Get-Date) -lt $deadline) {
    $state = Get-PostState $id
    if ($state -eq "PUBLISHED") { return $true }
    if ($state -eq "ERROR")     { Write-Host "  post $id -> ERROR (see DB error column)"; return $false }
    if (-not $healed -and (Get-StuckCount) -ge 1) { Restart-Postiz; $healed = $true; continue }
    Start-Sleep -Seconds 6
  }
  return ((Get-PostState $id) -eq "PUBLISHED")
}

if ($HealOnly) {
  $stuck = Get-StuckCount
  if ($stuck -ge 1) { Write-Host "$stuck post(s) stuck in QUEUE - healing."; Restart-Postiz; Write-Host "Stuck after heal: $(Get-StuckCount)" }
  else { Write-Host "No stuck posts. Worker healthy." }
  exit 0
}

if (-not $IntegrationId -or -not $Content) { throw "IntegrationId and Content are required (or use -HealOnly)." }

$id = New-Post $Content $IntegrationId $Media $Settings
Write-Host "Created post $id; verifying it publishes..."
if (Wait-Published $id) { Write-Host "PUBLISHED: $id" }
else { Write-Host "NOT published within ${VerifyTimeoutSec}s: $id (investigate)"; exit 1 }
