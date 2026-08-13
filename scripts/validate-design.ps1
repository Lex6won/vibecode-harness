param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Text([string]$RelativePath) {
  $path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required harness file: $RelativePath"
  }
  return Get-Content -LiteralPath $path -Encoding utf8 -Raw
}

function Get-YamlList([string]$Text, [string]$Key) {
  $lines = $Text -split "`r?`n"
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $match = [regex]::Match($lines[$index], "^(?<indent>\s*)$([regex]::Escape($Key)):\s*$")
    if (-not $match.Success) { continue }

    $indent = $match.Groups["indent"].Value.Length
    $items = [System.Collections.Generic.List[string]]::new()
    for ($cursor = $index + 1; $cursor -lt $lines.Count; $cursor++) {
      $line = $lines[$cursor]
      if ($line -match "^\s*$") { continue }
      $item = [regex]::Match($line, "^\s{$($indent + 2)}-\s+(?<value>[^#\r\n]+?)\s*$")
      if ($item.Success) {
        $items.Add($item.Groups["value"].Value.Trim().Trim('"', "'"))
        continue
      }
      $lineIndent = ($line -replace "^(\s*).*", '$1').Length
      if ($lineIndent -le $indent) { break }
    }
    if ($items.Count -eq 0) { throw "YAML list '$Key' is empty or malformed" }
    return @($items)
  }
  throw "YAML list '$Key' was not found"
}

function Get-Set([string[]]$Values) {
  return @($Values | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)
}

function Assert-SetEqual([string]$Name, [string[]]$Actual, [string[]]$Expected) {
  $actualText = (Get-Set $Actual) -join ","
  $expectedText = (Get-Set $Expected) -join ","
  if ($actualText -ne $expectedText) {
    throw "$Name mismatch. Expected [$expectedText], got [$actualText]"
  }
}

function Get-AdapterMarker([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^<!--\s*vibecode-harness:\s*allowed_languages=(?<languages>[a-z,]+);\s*verify_command=(?<command>[^;]+)\s*-->\s*$")
  if (-not $match.Success) { throw "$Name is missing its machine-readable policy marker" }
  return @{ languages = @($match.Groups["languages"].Value -split ","); command = $match.Groups["command"].Value.Trim() }
}

$requiredFiles = @(
  "README.md",
  "shared/harness-core.yaml",
  "shared/institution-profile.yaml",
  "shared/policies/design-discovery.yaml",
  "shared/policies/execution-contract.yaml",
  "shared/policies/trust-and-integrity.yaml",
  "shared/policies/checker-contract.yaml",
  "shared/policies/checker-signals.yaml",
  "adapters/codex/AGENTS.template.md",
  "adapters/claude-code/CLAUDE.template.md",
  "templates/harness.lock.example.json",
  "templates/work-status.schema.json",
  "templates/visual-review-receipt.schema.json",
  "docs/01_execution_harness_design.md",
  "docs/04_adversarial_design_review.md",
  "docs/07_integrated_execution_contract.md",
  "docs/08_legacy_asset_migration.md"
)
foreach ($relativePath in $requiredFiles) { [void](Get-Text $relativePath) }

$core = Get-Text "shared/harness-core.yaml"
$institutionProfile = Get-Text "shared/institution-profile.yaml"
$codex = Get-Text "adapters/codex/AGENTS.template.md"
$claude = Get-Text "adapters/claude-code/CLAUDE.template.md"
$execution = Get-Text "shared/policies/execution-contract.yaml"
$checkerContract = Get-Text "shared/policies/checker-contract.yaml"
$checkerSignals = Get-Text "shared/policies/checker-signals.yaml"

$expectedLanguages = @("python", "javascript", "typescript")
$expectedDenied = @("java", "go", "php", "ruby", "csharp", "rust")
$coreAllowed = Get-YamlList $core "allowed_languages"
$coreDenied = Get-YamlList $core "denied_without_exception"
$profileAllowed = Get-YamlList $institutionProfile "allowed_function_implementation_languages"
$profileDenied = Get-YamlList $institutionProfile "exception_required_for"

Assert-SetEqual "Core allowed language policy" $coreAllowed $expectedLanguages
Assert-SetEqual "Core denied language policy" $coreDenied $expectedDenied
Assert-SetEqual "Institution allowed language policy" $profileAllowed $expectedLanguages
Assert-SetEqual "Institution exception language policy" $profileDenied $expectedDenied

$overlap = Compare-Object (Get-Set $coreAllowed) (Get-Set $coreDenied) -IncludeEqual -ExcludeDifferent
if ($overlap) { throw "Allowed and denied language policies overlap: $($overlap.InputObject -join ', ')" }

foreach ($adapter in @(@{ name = "Codex adapter"; text = $codex }, @{ name = "Claude Code adapter"; text = $claude })) {
  $marker = Get-AdapterMarker $adapter.text $adapter.name
  Assert-SetEqual "$($adapter.name) language marker" $marker.languages $expectedLanguages
  if ($marker.command -ne "gg verify") { throw "$($adapter.name) verify command drifted: $($marker.command)" }
}

foreach ($marker in @("checker_invocation:", "pending_upstream_machine_verdict", "profile_fallback", "checker_incomplete", "checker_review_required")) {
  if ($execution -notmatch [regex]::Escape($marker)) { throw "Execution contract is missing: $marker" }
}
foreach ($marker in @("--check-deps", "--include-installed", "public-default-strict", "pending_upstream_machine_verdict", "prohibited_inference_sources")) {
  if ($checkerContract -notmatch [regex]::Escape($marker)) { throw "Checker contract is missing: $marker" }
}
foreach ($marker in @("kev_checked", "version_exact", "source_scope", "registry_status")) {
  if ($checkerSignals -notmatch [regex]::Escape($marker)) { throw "Checker signal policy is missing: $marker" }
}

Write-Output '{"status":"passed","check":"vibecode_harness_design_consistency"}'
