# Postiz CLI wrapper for the local container.
#
# Loads POSTIZ_API_KEY from this dir's .env (gitignored), points the
# CLI at the local container's backend (host port 3030), and forwards
# all args to the `postiz` global npm install.
#
# Usage:
#   ./infrastructure/marketing/postiz.ps1 auth:status
#   ./infrastructure/marketing/postiz.ps1 integrations:list
#   ./infrastructure/marketing/postiz.ps1 posts:list
#
# This script is committed; .env is not. The key never appears in the
# script or any committed file.

param([Parameter(ValueFromRemainingArguments=$true)] $Args)

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Error "Missing $envFile (copy from .env.example and fill in POSTIZ_API_KEY)"
    exit 1
}

$line = Get-Content $envFile | Where-Object { $_ -match "^POSTIZ_API_KEY=" } | Select-Object -First 1
if (-not $line) {
    Write-Error "POSTIZ_API_KEY not set in $envFile"
    exit 1
}

$env:POSTIZ_API_URL = "http://localhost:3030"
$env:POSTIZ_API_KEY = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")

& postiz @Args
