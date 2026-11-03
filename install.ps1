[CmdletBinding()]
param(
  # README·docs/18 이 안내하는 경로와 같아야 한다 - 두 문서는 github-pilot 하위 폴더를 가리킨다.
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Gyeonggi\VibeCodeHarness\github-pilot"),
  # 없을 때 winget 으로 Node.js LTS·Python 설치를 시도한다(설치 창 승인은 사용자). 스위치가 없으면 안내만 하고 멈춘다.
  [switch]$InstallPrerequisites,
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

function Invoke-WingetInstall {
  param([string]$PackageId)
  $winget = Find-CommandPath "winget"
  if ($null -eq $winget) { return $false }
  Write-Host "Installing $PackageId with winget (approve the Windows prompt if one appears)..."
  & $winget install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements --scope user
  return ($LASTEXITCODE -eq 0)
}

function InstallPrerequisites {
  $node = Find-Node
  if ($null -eq $node -and $InstallPrerequisites) {
    if (Invoke-WingetInstall "OpenJS.NodeJS.LTS") { $node = Find-Node }
  }
  if ($null -eq $node) {
    Stop-Install "Node.js 22 or later is required. Install it with: winget install OpenJS.NodeJS.LTS (or re-run with -InstallPrerequisites)"
  }

  if (-not $SkipChecker) {
    $python = Find-Python
    if ($null -eq $python -and $InstallPrerequisites) {
      if (Invoke-WingetInstall "Python.Python.3.13") { $python = Find-Python }
    }
    if ($null -eq $python) {
      Stop-Install "Python is required for the local checker path. Install it with: winget install Python.Python.3.13 (or re-run with -InstallPrerequisites)"
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

function Retire-LegacyInstall {
  # M7: 예전 기본 경로(…\VibeCodeHarness)에 설치본이 있으면 새 기본 경로(…\github-pilot)와 두 벌이 공존하고,
  # PATH 에 등록된 옛 gg.cmd 가 계속 쓰인다. 옛 런처를 비활성 이름으로 옮기고 사용자에게 알린다(삭제하지 않는다).
  param([string]$Destination)
  $legacyRoot = Split-Path -Parent $Destination
  if ((Split-Path -Leaf $Destination) -ne "github-pilot") { return $null }
  $legacyLauncher = Join-Path $legacyRoot "gg.cmd"
  if (-not (Test-Path -LiteralPath $legacyLauncher)) { return $null }
  $retired = "$legacyLauncher.superseded-$PID"
  Rename-Item -LiteralPath $legacyLauncher -NewName (Split-Path -Leaf $retired)
  Write-Warning "Previous harness launcher found at $legacyLauncher. It was renamed to $retired so that only the new installation ($Destination) is used. If $legacyRoot is on your PATH, replace it with $Destination (see README: 이전 설치 정리)."
  return $retired
}

try {
  $node = InstallPrerequisites
  $source = Get-HarnessSource
  $retiredLauncher = Retire-LegacyInstall -Destination $InstallDir
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
  if ($retiredLauncher) {
    $receiptPath = Join-Path $InstallDir ".vibecode-harness-install.json"
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $receipt | Add-Member -NotePropertyName "retired_legacy_launcher" -NotePropertyValue $retiredLauncher
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
