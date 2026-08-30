param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][string]$TrustPath,
  [Parameter(Mandatory = $true)][string]$InnoSetupPath,
  [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
  [Parameter(Mandatory = $true)][string]$TimestampUrl,
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$bundle = (Resolve-Path -LiteralPath $BundlePath).Path
$trust = (Resolve-Path -LiteralPath $TrustPath).Path
$iscc = (Resolve-Path -LiteralPath $InnoSetupPath).Path
$signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
$node = Join-Path $bundle "runtime\node.exe"

# Node is embedded solely to run the Harness. Python and the security checker
# are server-side Portal components and must not be included in the user EXE.
if (-not (Test-Path -LiteralPath $node)) { throw "Approved embedded Node runtime is missing from the bundle." }
if (-not (Test-Path -LiteralPath (Join-Path $bundle "gg.cmd"))) { throw "User launcher gg.cmd is missing from the bundle." }
$manager = Join-Path $bundle "manager.ps1"
if (-not (Test-Path -LiteralPath $manager)) { throw "Harness Manager GUI script is missing from the bundle." }
$managerBytes = [System.IO.File]::ReadAllBytes($manager)
if ($managerBytes.Length -lt 3 -or $managerBytes[0] -ne 0xEF -or $managerBytes[1] -ne 0xBB -or $managerBytes[2] -ne 0xBF) {
  throw "Manager PowerShell script must be UTF-8 with BOM for Windows PowerShell -File execution."
}
if (-not (Test-Path -LiteralPath (Join-Path $bundle "bundle.manifest.json"))) { throw "Signed bundle manifest is missing from the bundle." }

& $node (Join-Path $root "bin\gg.mjs") bundle verify --bundle $bundle --trust $trust
if ($LASTEXITCODE -ne 0) { throw "Unsigned or invalid bundle cannot be turned into an installer." }

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
& $iscc "/DBundlePath=$bundle" "/O$OutputPath" (Join-Path $root "installer\vibecode-harness.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }

$installer = Get-ChildItem -LiteralPath $OutputPath -Filter "Gyeonggi-VibeCode-Harness-Setup.exe" | Select-Object -First 1
if ($null -eq $installer) { throw "Installer executable was not created." }

& $signtool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $installer.FullName
if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed." }
& $signtool verify /pa /all $installer.FullName
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed." }

Write-Output "Signed installer: $($installer.FullName)"
