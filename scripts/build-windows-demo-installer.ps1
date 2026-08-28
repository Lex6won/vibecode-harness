[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][string]$TrustPath,
  [Parameter(Mandatory = $true)][string]$InnoSetupPath,
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
$trust = (Resolve-Path -LiteralPath $TrustPath).Path
$iscc = (Resolve-Path -LiteralPath $InnoSetupPath).Path
$node = Join-Path $bundle "runtime\node.exe"

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Approved embedded Node runtime is missing from the bundle." }
if (-not (Test-Path -LiteralPath (Join-Path $bundle "gg.cmd") -PathType Leaf)) { throw "User launcher gg.cmd is missing from the bundle." }
if (-not (Test-Path -LiteralPath (Join-Path $bundle "manager.ps1") -PathType Leaf)) { throw "Harness Manager GUI script is missing from the bundle." }

& $node (Join-Path $root "bin\gg.mjs") bundle verify --bundle $bundle --trust $trust
if ($LASTEXITCODE -ne 0) { throw "Unsigned or invalid bundle cannot be turned into a demonstration installer." }

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
& $iscc "/DDemoBuild=1" "/DBundlePath=$bundle" "/O$OutputPath" (Join-Path $root "installer\vibecode-harness.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }

$installer = Get-ChildItem -LiteralPath $OutputPath -Filter "Gyeonggi-VibeCode-Harness-Demo-Unsigned-Setup.exe" | Select-Object -First 1
if ($null -eq $installer) { throw "Demonstration installer executable was not created." }

$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Demonstration installer (unsigned): $($installer.FullName)"
Write-Output "SHA256: $hash"
Write-Warning "This is an unsigned demonstration installer. Do not publish it as an institutional production release."
