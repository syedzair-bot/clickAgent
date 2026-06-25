# ClickUp Git Sync — Windows Installer (PowerShell)
# Run once: powershell -ExecutionPolicy Bypass -File .\install.ps1

$AgentDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$HooksDir   = Join-Path $AgentDir "global-hooks"
$ConfigFile = Join-Path $AgentDir "config.json"
$CcHook     = Join-Path $AgentDir "cc-hook.mjs"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗"
Write-Host "║     ClickUp Git Sync — Windows Installer     ║"
Write-Host "╚══════════════════════════════════════════════╝"
Write-Host ""
Write-Host "  Agent: $AgentDir"
Write-Host ""

# ── Step 1: Ask which repos this developer works on ──────────────────────────
Write-Host "── Step 1: Configure your repos ────────────────"
Write-Host ""
Write-Host "  Which DegrePartner apps do you work on?"
Write-Host "  (Enter app names one by one, empty line to finish)"
Write-Host "  Common apps: DT · DTL · AdminCMS · UniAdv"
Write-Host ""

$repoPaths = @()

while ($true) {
    $appName = Read-Host "  App name (or press Enter to finish)"
    if ([string]::IsNullOrWhiteSpace($appName)) { break }

    # Auto-detect common locations
    $candidates = @(
        "$env:USERPROFILE\DegrePartner\$appName",
        "$env:USERPROFILE\Projects\$appName",
        "C:\Projects\$appName",
        "C:\code\$appName"
    )
    $suggested = $candidates | Where-Object { Test-Path (Join-Path $_ ".git") } | Select-Object -First 1

    if ($suggested) {
        $userPath = Read-Host "  Path [$suggested] (Enter to accept)"
        $finalPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $suggested } else { $userPath }
    } else {
        $finalPath = Read-Host "  Full path to $appName repo"
    }

    if ([string]::IsNullOrWhiteSpace($finalPath)) {
        Write-Host "  ⚠  No path provided — skipping $appName"
        continue
    }

    if (-not (Test-Path (Join-Path $finalPath ".git"))) {
        Write-Host "  ⚠  No .git found at $finalPath — adding anyway"
    } else {
        Write-Host "  ✓  $appName → $finalPath"
    }

    $repoPaths += $finalPath.Replace("\", "/")
}

Write-Host ""

# ── Step 2: Save to config.json ──────────────────────────────────────────────
Write-Host "── Step 2: Saving config ────────────────────────"

$cfg = @{}
if (Test-Path $ConfigFile) {
    try { $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json -AsHashtable } catch {}
}
$cfg["TRACKED_REPOS"] = $repoPaths

$cfg | ConvertTo-Json -Depth 5 | Set-Content $ConfigFile -Encoding UTF8
Write-Host "  ✓  Tracked repos saved:"
$repoPaths | ForEach-Object { Write-Host "       $_" }
Write-Host ""

# ── Step 3: Set global git hooks path ────────────────────────────────────────
Write-Host "── Step 3: Global git hook ──────────────────────"

$existing = git config --global core.hooksPath 2>$null
if ($existing -and $existing -ne $HooksDir) {
    Write-Host "  ⚠  core.hooksPath already set to: $existing"
    $confirm = Read-Host "  Overwrite? [y/N]"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "  Skipped."
    } else {
        git config --global core.hooksPath $HooksDir
        Write-Host "  ✓  Global hooks path → $HooksDir"
    }
} else {
    git config --global core.hooksPath $HooksDir
    Write-Host "  ✓  Global hooks path → $HooksDir"
}

Write-Host ""
Write-Host "✅ Done."
Write-Host ""
Write-Host "   Git pushes from your configured repos will trigger ClickUp sync."
Write-Host "   To add repos: re-run install.ps1"
Write-Host "   To update API key: edit config.json"
Write-Host ""
