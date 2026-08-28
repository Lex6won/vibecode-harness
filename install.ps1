[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Gyeonggi\VibeCodeHarness\github-pilot"),
  [switch]$InstallPrerequisites,
  [switch]$SkipChecker,
  [switch]$AddToUserPath,
  [switch]$AllowGitHubPilotSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "[VibeCode Harness] $Message" -ForegroundColor Cyan
}

function Stop-Install([string]$Message) {
  Write-Error $Message
  exit 2
}

function Find-CommandPath([string]$Name, [string[]]$Candidates = @()) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command -and $command.CommandType -eq "Application") { return $command.Source }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}

function Test-WindowsStoreAlias([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return $Path -like "*\Microsoft\WindowsApps\python.exe"
}

function Join-WhenRoot([string]$Root, [string]$Child) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
  return Join-Path $Root $Child
}

function Find-Node {
  return Find-CommandPath "node.exe" @(
    (Join-WhenRoot $env:ProgramFiles "nodejs\node.exe"),
    (Join-WhenRoot ${env:ProgramFiles(x86)} "nodejs\node.exe")
  )
}

function Find-Python {
  $candidates = @()
  foreach ($root in @(
    (Join-WhenRoot $env:LOCALAPPDATA "Programs\Python"),
    (Join-WhenRoot $env:ProgramFiles "Python"),
    (Join-WhenRoot ${env:ProgramFiles(x86)} "Python")
  )) {
    if ($root -and (Test-Path -LiteralPath $root -PathType Container)) {
      $candidates += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^Python\d+(?:-\d+)?$' } |
        ForEach-Object { Join-Path $_.FullName "python.exe" }
    }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  $python = Find-CommandPath "python.exe"
  if (Test-WindowsStoreAlias $python) { return $null }
  return $python
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
  if (-not $winget) { Stop-Install "$Label 설치가 필요하지만 Windows App Installer(winget)를 찾지 못했습니다. IT 지원을 통해 $Label 설치 후 다시 실행하세요." }
  Write-Step "$Label 설치를 시작합니다. Windows 설치 창이 열리면 안내에 따라 승인하세요."
  & $winget.Source install --exact --id $Id --scope user --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Stop-Install "$Label 설치가 완료되지 않았습니다. 설치를 취소했거나 Windows 설치 권한이 필요합니다." }
}

function Copy-HarnessToInstallDir([string]$Source, [string]$Destination) {
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $staging = "$Destination.staging-$PID"
  $backup = "$Destination.backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
  if (Test-Path -LiteralPath $staging) { Stop-Install "임시 설치 폴더가 이미 있습니다. 잠시 후 다시 실행하세요." }
  try {
    New-Item -ItemType Directory -Path $staging | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | Where-Object {
      $_.Name -notin @('.git', 'node_modules', '_check-reports', 'evidence', 'dist', 'release', 'public')
    } | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
    }
    if (Test-Path -LiteralPath $Destination) { Rename-Item -LiteralPath $Destination -NewName (Split-Path -Leaf $backup) }
    Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $Destination)
  } catch {
    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Destination)) {
      Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $Destination)
    }
    throw
  }
  return $backup
}

if ($env:OS -ne "Windows_NT") { Stop-Install "이 설치 스크립트는 Windows 전용입니다." }
$source = Split-Path -Parent $PSCommandPath
foreach ($required in @("bin\gg.mjs", "bin\antigravity-pre-tool.mjs", "adapters\antigravity\plugin.json", "lib\release-integrity.mjs", "shared\harness-core.yaml")) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $required))) { Stop-Install "GitHub ZIP을 완전히 푼 하네스 폴더에서 install.ps1을 실행하세요. 누락: $required" }
}

if (-not $AllowGitHubPilotSource) {
  Stop-Install "이 스크립트는 GitHub 소스 기반 시범 설치입니다. 공식 기관 배포본이 아닙니다. 내용을 확인한 뒤 -AllowGitHubPilotSource 옵션을 붙여 다시 실행하세요."
}

$node = Find-Node
if (-not $node -and $InstallPrerequisites) { Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"; $node = Find-Node }
if (-not $node) { Stop-Install "Node.js 22 이상이 필요합니다. -InstallPrerequisites 옵션으로 설치하거나 IT 지원을 통해 설치하세요." }
$nodeMajor = [int]((& $node --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Stop-Install "Node.js 22 이상이 필요합니다. 현재 버전: $(& $node --version)" }

$python = $null
if (-not $SkipChecker) {
  $python = Find-Python
  if (-not $python -and $InstallPrerequisites) { Install-WingetPackage "Python.Python.3.13" "Python 3.13"; $python = Find-Python }
  if (-not $python) { Stop-Install "보안 체커 설치에는 Python 3.11 이상이 필요합니다. -InstallPrerequisites 옵션으로 설치하거나 -SkipChecker로 하네스만 설치하세요." }
  $pythonVersion = [version]((& $python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim())
  if ($pythonVersion -lt [version]"3.11") { Stop-Install "Python 3.11 이상이 필요합니다. 현재 버전: $pythonVersion" }
  Write-Step "GitHub 시범 소스에서 보안 체커를 설치합니다. 설치 중에는 원본 소스나 점검 결과를 전송하지 않습니다."
  & $python -m pip install --user --upgrade "https://github.com/Lex6won/vibecode-checker/archive/refs/heads/main.zip"
  if ($LASTEXITCODE -ne 0) { Stop-Install "보안 체커 설치에 실패했습니다. 네트워크, 프록시 또는 Python 패키지 설치 권한을 확인하세요." }
}

Write-Step "하네스 파일을 사용자 폴더에 설치합니다. 기존 설치는 백업하고 새 설치가 정상 배치된 뒤에만 교체합니다."
$backup = Copy-HarnessToInstallDir $source $InstallDir
$wrapper = Join-Path $InstallDir "gg.cmd"
$escapedNode = $node.Replace('"', '""')
Set-Content -LiteralPath $wrapper -Encoding Ascii -Value @(
  "@echo off",
  "`"$escapedNode`" `"%~dp0bin\gg.mjs`" %*"
)

$receipt = [ordered]@{
  schema_version = 1
  installation_kind = "github_pilot"
  installed_at = (Get-Date).ToUniversalTime().ToString("o")
  source_directory = $source
  node_path = $node
  python_path = $python
  checker_source = if ($SkipChecker) { "not_requested" } else { "https://github.com/Lex6won/vibecode-checker/archive/refs/heads/main.zip" }
  previous_install_backup = if (Test-Path -LiteralPath $backup) { $backup } else { $null }
}
$receiptJson = $receipt | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $InstallDir ".vibecode-harness-install.json"), $receiptJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

if ($AddToUserPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ((@($userPath -split ';') | Where-Object { $_ -eq $InstallDir }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(';') + ";" + $InstallDir).Trim(';')), "User")
  }
}

Write-Step "설치가 완료되었습니다. 다음으로 하네스와 체커 상태를 확인합니다."
& $node (Join-Path $InstallDir "bin\gg.mjs") doctor --project $InstallDir
if ($LASTEXITCODE -eq 70) { Stop-Install "설치 파일은 복사되었지만 하네스 실행 확인에 실패했습니다. 설치 영수증을 보관하고 IT 지원에 문의하세요." }
Write-Host "`n완료: $InstallDir" -ForegroundColor Green
Write-Host "다음 명령으로 프로젝트에 하네스를 적용하세요:" -ForegroundColor Green
Write-Host "  `"$wrapper`" init --project C:\work\my-service --tools both --runtime typescript_web --level L2" -ForegroundColor Yellow
