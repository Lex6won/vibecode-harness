param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vibecode-harness-mutation-" + [guid]::NewGuid().ToString("N"))

function Assert-MutationFails([string]$Name, [scriptblock]$Mutate) {
  Copy-Item -LiteralPath $Root -Destination $temporaryRoot -Recurse
  try {
    & $Mutate $temporaryRoot
    $rejected = $false
    try {
      & (Join-Path $temporaryRoot "scripts\validate-design.ps1") -Root $temporaryRoot 2>$null
    }
    catch {
      $rejected = $true
    }
    if (-not $rejected) { throw "Mutation '$Name' unexpectedly passed validation" }
    Write-Output "PASS mutation rejected: $Name"
  }
  finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
  }
}

Assert-MutationFails "unexpected allowed language" {
  param($copy)
  $path = Join-Path $copy "shared\harness-core.yaml"
  $text = Get-Content -LiteralPath $path -Raw -Encoding utf8
  $text = $text -replace "(?m)^    - typescript\r?$", "    - typescript`r`n    - go"
  Set-Content -LiteralPath $path -Value $text -Encoding utf8 -NoNewline
}
Assert-MutationFails "allowed denied overlap" {
  param($copy)
  $path = Join-Path $copy "shared\harness-core.yaml"
  $text = Get-Content -LiteralPath $path -Raw -Encoding utf8
  $text = $text -replace "(?m)^  denied_without_exception:\r?$", "  denied_without_exception:`r`n    - typescript"
  Set-Content -LiteralPath $path -Value $text -Encoding utf8 -NoNewline
}
Assert-MutationFails "adapter policy drift" {
  param($copy)
  $path = Join-Path $copy "adapters\codex\AGENTS.template.md"
  $text = Get-Content -LiteralPath $path -Raw -Encoding utf8
  $text = $text.Replace("allowed_languages=python,javascript,typescript", "allowed_languages=python,javascript,typescript,go")
  Set-Content -LiteralPath $path -Value $text -Encoding utf8 -NoNewline
}
Assert-MutationFails "malformed package policy" {
  param($copy)
  Set-Content -LiteralPath (Join-Path $copy "shared\references\package-policy.json") -Value "{ invalid" -Encoding utf8 -NoNewline
}

Write-Output '{"status":"passed","check":"vibecode_harness_design_mutations"}'
