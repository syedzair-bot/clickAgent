# ClickUp Git Sync - Windows Installer (PowerShell 5.1+)
# Run: powershell -ExecutionPolicy Bypass -File .\install.ps1

$AgentDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$HooksDir   = Join-Path $AgentDir "global-hooks"
$ConfigFile = Join-Path $AgentDir "config.json"

Write-Host ""
Write-Host "======================================================"
Write-Host "       ClickUp Git Sync - Windows Installer"
Write-Host "======================================================"
Write-Host ""
Write-Host "  Agent dir: $AgentDir"
Write-Host ""

# -- Step 1: Ask which repos this developer works on --------------------------
Write-Host "-- Step 1: Configure your repos --"
Write-Host ""
Write-Host "  Which DegrePartner apps do you work on?"
Write-Host "  Enter app names one by one. Press Enter with no name to finish."
Write-Host "  Common apps: DT, DTL, AdminCMS, UniAdv"
Write-Host ""

$repoPaths = New-Object System.Collections.ArrayList

while ($true) {
    $appName = Read-Host "  App name (blank to finish)"
    if ([string]::IsNullOrWhiteSpace($appName)) { break }

    $candidates = @(
        "$env:USERPROFILE\DegrePartner\$appName",
        "$env:USERPROFILE\Projects\$appName",
        "C:\Projects\$appName",
        "C:\code\$appName",
        "$env:USERPROFILE\Desktop\$appName"
    )

    $suggested = $null
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c ".git")) {
            $suggested = $c
            break
        }
    }

    if ($suggested) {
        $userPath = Read-Host "  Path [$suggested] (Enter to accept)"
        if ([string]::IsNullOrWhiteSpace($userPath)) {
            $finalPath = $suggested
        } else {
            $finalPath = $userPath
        }
    } else {
        $finalPath = Read-Host "  Full path to $appName repo"
    }

    if ([string]::IsNullOrWhiteSpace($finalPath)) {
        Write-Host "  SKIP: No path provided for $appName"
        continue
    }

    $finalPath = $finalPath.TrimEnd("\").TrimEnd("/")

    if (-not (Test-Path (Join-Path $finalPath ".git"))) {
        Write-Host "  WARN: No .git found at $finalPath - adding anyway"
    } else {
        Write-Host "  OK: $appName -> $finalPath"
    }

    [void]$repoPaths.Add($finalPath.Replace("\", "/"))
}

Write-Host ""

# -- Step 2: Save to config.json ----------------------------------------------
Write-Host "-- Step 2: Saving config --"

$existingJson = "{}"
if (Test-Path $ConfigFile) {
    $existingJson = Get-Content $ConfigFile -Raw -Encoding UTF8
}

$cfg = $existingJson | ConvertFrom-Json

# Build JSON array string for tracked repos
$pathsJson = ($repoPaths | ForEach-Object { "`"$_`"" }) -join ", "
$trackedArray = "[$pathsJson]"

# Rebuild config using Node so we don't corrupt existing keys
$nodeScript = @"
var fs = require('fs');
var cfg = JSON.parse(fs.readFileSync('$($ConfigFile.Replace("\","\\"))', 'utf8'));
cfg.TRACKED_REPOS = $trackedArray;
fs.writeFileSync('$($ConfigFile.Replace("\","\\"))', JSON.stringify(cfg, null, 2));
console.log('Config saved.');
"@

$nodeScript | node

Write-Host "  Tracked repos:"
$repoPaths | ForEach-Object { Write-Host "    $_" }
Write-Host ""

# -- Step 3: Set global git hooks path ----------------------------------------
Write-Host "-- Step 3: Global git hook --"

$hooksForward = $HooksDir.Replace("\", "/")
$existing = git config --global core.hooksPath 2>$null

if ($existing -and $existing -ne $HooksDir -and $existing -ne $hooksForward) {
    Write-Host "  WARN: core.hooksPath already set to: $existing"
    $confirm = Read-Host "  Overwrite? [y/N]"
    if ($confirm -eq "y" -or $confirm -eq "Y") {
        git config --global core.hooksPath $hooksForward
        Write-Host "  OK: Global hooks path set"
    } else {
        Write-Host "  Skipped."
    }
} else {
    git config --global core.hooksPath $hooksForward
    Write-Host "  OK: Global hooks path -> $hooksForward"
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  Done! Git pushes from your repos will now sync"
Write-Host "  to ClickUp automatically."
Write-Host ""
Write-Host "  To add more repos: re-run install.ps1"
Write-Host "  To update API key: edit config.json"
Write-Host "======================================================"
Write-Host ""
