param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath
& node (Join-Path $root "bin\gg.mjs") @Arguments
exit $LASTEXITCODE
