[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Gyeonggi\\VibeCodeHarness"),
  [switch]$SkipChecker,
  [switch]$AllowGitHubPilotSource,
  [switch]$AddToUserPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Stop-Install {
  param([string]$Message)
  Write-Error $Message
  exit 2
}

function Find-CommandPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Find-Node {
  $node = Find-CommandPath "node"
  if ($null -eq $node) { return $null }
  try {
    $version = & $node --version
    if ($LASTEXITCODE -ne 0) { return $null }
    $major = [int](($version -replace "^v", "").Split(".")[0])
    if ($major -lt 22) { return $null }
    return $node
  } catch {
    return $null
  }
}

function Test-WindowsStoreAlias {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return $Path -like "*Microsoft\WindowsApps\python.exe"
}

function Find-Python {
  $python = Find-CommandPath "python"
  if ($null -eq $python) { $python = Find-CommandPath "py" }
  if ($null -eq $python) { return $null }
  if (Test-WindowsStoreAlias $python) { return $null }
  return $python
}

function InstallPrerequisites {
  $node = Find-Node
  if ($null -eq $node) {
    Stop-Install "Node.js 22 or later is required. Install it with: winget install OpenJS.NodeJS.LTS"
  }

  if (-not $SkipChecker) {
    $python = Find-Python
    if ($null -eq $python) {
      Stop-Install "Python is required for the legacy local checker path. Install it with: winget install Python.Python.3.13"
    }
  }

  return $node
}

function Get-HarnessSource {
  if (-not $AllowGitHubPilotSource) {
    Stop-Install "GitHub pilot source is moving and requires explicit acknowledgement. Re-run with -AllowGitHubPilotSource, or use the signed installer."
  }

  $scriptRoot = Split-Path -Parent $PSCommandPath
  $candidate = Resolve-Path (Join-Path $scriptRoot ".")
  $hasHarness = Test-Path (Join-Path $candidate "bin\\gg.mjs")
  if ($hasHarness) { return $candidate.Path }

  $archiveUrl = "https://github.com/Lex6won/vibecode-harness/archive/refs/heads/main.zip"
  $checkerArchiveUrl = "https://github.com/Lex6won/vibecode-checker/archive/refs/heads/main.zip"
  Stop-Install "GitHub pilot source download is not available in this package. Download the repository archive from $archiveUrl. The legacy checker archive is $checkerArchiveUrl."
}

function Copy-HarnessToInstallDir {
  param(
    [string]$Source,
    [string]$Destination
  )

  $parent = Split-Path -Parent $Destination
  if ([string]::IsNullOrWhiteSpace($parent)) { Stop-Install "Install directory must have a parent directory." }
  New-Item -ItemType Directory -Path $parent -Force | Out-Null

  $staging = "$Destination.staging-$PID"
  $backup = "$Destination.backup-$PID"
  if (Test-Path -LiteralPath $staging) { Stop-Install "Staging directory already exists: $staging" }

  try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $excluded = @(".git", "node_modules", "_check-reports", "evidence", "dist", "release", "public")
    Get-ChildItem -LiteralPath $Source -Force | Where-Object { $_.Name -notin $excluded } | Copy-Item -Destination $staging -Recurse -Force

    if (Test-Path -LiteralPath $Destination) {
      Rename-Item -LiteralPath $Destination -NewName (Split-Path -Leaf $backup)
    }
    Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $Destination)
  } catch {
    if ((-not (Test-Path -LiteralPath $Destination)) -and (Test-Path -LiteralPath $backup)) {
      Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $Destination)
    }
    throw
  }

  return $backup
}

function Write-InstallReceipt {
  param(
    [string]$Destination,
    [string]$Source,
    [bool]$CheckerSkipped
  )

  $receipt = [ordered]@{
    installation_kind = "github_pilot"
    installed_at = (Get-Date).ToUniversalTime().ToString("o")
    source_directory = $Source
    checker_source = $(if ($CheckerSkipped) { "not_requested" } else { "legacy_local_path" })
  }
  $receiptPath = Join-Path $Destination ".vibecode-harness-install.json"
  $json = $receipt | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($receiptPath, $json, [System.Text.UTF8Encoding]::new($false))
}

try {
  $node = InstallPrerequisites
  $source = Get-HarnessSource
  $backup = Copy-HarnessToInstallDir -Source $source -Destination $InstallDir

  $wrapper = Join-Path $InstallDir "gg.cmd"
  $wrapperLines = @(
    "@echo off",
    ('"{0}" "%~dp0bin\\gg.mjs" %*' -f $node.Replace('"', '""'))
  )
  [System.IO.File]::WriteAllLines($wrapper, $wrapperLines, [System.Text.Encoding]::ASCII)
  Write-InstallReceipt -Destination $InstallDir -Source $source -CheckerSkipped $SkipChecker
  if (Test-Path -LiteralPath $backup) {
    $receiptPath = Join-Path $InstallDir ".vibecode-harness-install.json"
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $receipt | Add-Member -NotePropertyName "previous_install_backup" -NotePropertyValue $backup
    [System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
  }

  if ($AddToUserPath) {
    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @()
    if (-not [string]::IsNullOrWhiteSpace($currentUserPath)) {
      $segments = @($currentUserPath -split ";" | Where-Object { $_ })
    }
    if ($segments -notcontains $InstallDir) {
      [Environment]::SetEnvironmentVariable("Path", (@($segments + $InstallDir) -join ";"), "User")
    }
  }

  & $node (Join-Path $InstallDir "bin\\gg.mjs") doctor --project $InstallDir
  if ($LASTEXITCODE -eq 70) { Stop-Install "Installed harness bundle integrity verification failed." }
  Write-Host "Harness installation completed: $InstallDir"
  if (Test-Path -LiteralPath $backup) { Write-Host "Previous installation retained at: $backup" }
  exit 0
} catch {
  Stop-Install $_.Exception.Message
}

# GitHub pilot contents include adapters\antigravity\plugin.json and antigravity-pre-tool.mjs.
