[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodeExecutable,
  [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
  [Parameter(Mandatory = $true)][string]$SignerKeyId,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [string]$BundleId = "gyeonggi-demo-0.2.0",
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\release\demo-bundle")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$node = (Resolve-Path -LiteralPath $NodeExecutable).Path
$privateKey = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

if ((Get-Item -LiteralPath $node).Name -ne "node.exe") { throw "NodeExecutable must be the approved node.exe file." }
if (Test-Path -LiteralPath $output) {
  $existing = Get-ChildItem -LiteralPath $output -Force
  if ($existing.Count -gt 0) { throw "OutputPath must be empty to prevent mixing release files: $output" }
} else {
  New-Item -ItemType Directory -Path $output | Out-Null
}

foreach ($file in @("gg.cmd", "manager.ps1")) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $output $file) -Force
}
foreach ($directory in @("bin", "lib", "adapters", "shared", "templates")) {
  Copy-Item -LiteralPath (Join-Path $root $directory) -Destination (Join-Path $output $directory) -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $output "runtime") | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $output "runtime\node.exe") -Force

$demoNotice = [ordered]@{
  channel = "demonstration"
  authenticode = "unsigned"
  message = "This package is for demonstration and validation only. Install the institutionally signed release for production use."
  source_commit = $SourceCommit
  source_tree = "local working tree; not an approved production source snapshot"
  built_at = [DateTime]::UtcNow.ToString("o")
}
[System.IO.File]::WriteAllText((Join-Path $output "demo-release.json"), ($demoNotice | ConvertTo-Json), $utf8WithoutBom)

$components = [ordered]@{
  harness = [ordered]@{ path = "bin/gg.mjs"; version = "0.2.0" }
  node_runtime = [ordered]@{ path = "runtime/node.exe"; version = "24.4.0" }
}
$componentsPath = Join-Path $output "bundle-components.json"
[System.IO.File]::WriteAllText($componentsPath, ($components | ConvertTo-Json -Depth 4), $utf8WithoutBom)

& $node (Join-Path $root "scripts\sign-release-bundle.mjs") `
  --bundle $output `
  --bundle-id $BundleId `
  --version 0.2.0 `
  --source-commit $SourceCommit `
  --signer-key-id $SignerKeyId `
  --private-key $privateKey `
  --components $componentsPath
if ($LASTEXITCODE -ne 0) { throw "Demonstration bundle signing failed." }

& $node (Join-Path $root "bin\gg.mjs") bundle verify --bundle $output --trust (Join-Path $output "shared\trust\approved-signers.json")
if ($LASTEXITCODE -ne 0) { throw "Demonstration bundle verification failed." }

Write-Output "Signed demonstration bundle: $output"
