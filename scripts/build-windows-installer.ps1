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

if (-not (Test-Path -LiteralPath (Join-Path $bundle "runtime\node.exe"))) { throw "승인된 Node 런타임이 번들에 없습니다." }
if (-not (Test-Path -LiteralPath (Join-Path $bundle "runtime\python.exe"))) { throw "승인된 Python 런타임이 번들에 없습니다." }
if (-not (Test-Path -LiteralPath (Join-Path $bundle "checker\gvskb.exe"))) { throw "승인된 체커 독립 실행 파일이 번들에 없습니다." }

& node (Join-Path $root "bin\gg.mjs") bundle verify --bundle $bundle --trust $trust
if ($LASTEXITCODE -ne 0) { throw "서명·해시 검증에 실패한 번들은 설치기로 만들 수 없습니다." }

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
& $iscc "/DBundlePath=$bundle" "/O$OutputPath" (Join-Path $root "installer\vibecode-harness.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 컴파일에 실패했습니다." }

$installer = Get-ChildItem -LiteralPath $OutputPath -Filter "Gyeonggi-VibeCode-Harness-Setup.exe" | Select-Object -First 1
if ($null -eq $installer) { throw "생성된 설치 파일을 찾지 못했습니다." }
& $signtool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $installer.FullName
if ($LASTEXITCODE -ne 0) { throw "설치 파일 코드서명에 실패했습니다." }
& $signtool verify /pa /all $installer.FullName
if ($LASTEXITCODE -ne 0) { throw "설치 파일 코드서명 검증에 실패했습니다." }
Write-Output "서명된 설치 파일: $($installer.FullName)"
