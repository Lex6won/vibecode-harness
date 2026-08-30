[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$installRoot = Split-Path -Parent $PSCommandPath
$launcher = Join-Path $installRoot "gg.cmd"
$demoRelease = Join-Path $installRoot "demo-release.json"
$isDemonstration = Test-Path -LiteralPath $demoRelease -PathType Leaf
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  [System.Windows.Forms.MessageBox]::Show("Harness launcher was not found. Repair the signed Harness installation.", "VibeCode Harness", "OK", "Error") | Out-Null
  exit 1
}

function Get-ProjectLock([string]$ProjectPath) {
  $lockPath = Join-Path $ProjectPath ".vibecode-harness\harness.lock.json"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Invoke-Harness([string[]]$Arguments) {
  try {
    $output = & $launcher @Arguments 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output.Trim() }
  } catch {
    return [pscustomobject]@{ ExitCode = 70; Output = $_.Exception.Message }
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = if ($isDemonstration) { "VibeCode Harness Manager - Demonstration" } else { "VibeCode Harness Manager" }
$form.Size = New-Object System.Drawing.Size(720, 630)
$form.MinimumSize = New-Object System.Drawing.Size(720, 630)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$appliedSuccessfully = $false

if ($isDemonstration) {
  $demoWarning = New-Object System.Windows.Forms.Label
  $demoWarning.Text = "UNSIGNED DEMONSTRATION BUILD - For validation only. Install the institutionally signed release for production."
  $demoWarning.ForeColor = [System.Drawing.Color]::DarkRed
  $demoWarning.AutoSize = $true
  $demoWarning.Location = New-Object System.Drawing.Point(24, 570)
  $form.Controls.Add($demoWarning)
}

$title = New-Object System.Windows.Forms.Label
$title.Text = "프로젝트에 사용할 개발 도구와 언어 정책을 선택하세요"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 20)
$form.Controls.Add($title)

$description = New-Object System.Windows.Forms.Label
$description.Text = "하네스는 AI 도구의 로그인 정보나 비밀번호를 읽지 않습니다. 최종 보안점검은 개발 후 포털에서 요청합니다."
$description.AutoSize = $true
$description.Location = New-Object System.Drawing.Point(26, 52)
$form.Controls.Add($description)

$projectLabel = New-Object System.Windows.Forms.Label
$projectLabel.Text = "프로젝트 폴더"
$projectLabel.AutoSize = $true
$projectLabel.Location = New-Object System.Drawing.Point(26, 92)
$form.Controls.Add($projectLabel)

$projectPath = New-Object System.Windows.Forms.TextBox
$projectPath.Size = New-Object System.Drawing.Size(560, 26)
$projectPath.Location = New-Object System.Drawing.Point(26, 114)
$form.Controls.Add($projectPath)

$browse = New-Object System.Windows.Forms.Button
$browse.Text = "폴더 선택"
$browse.Size = New-Object System.Drawing.Size(100, 26)
$browse.Location = New-Object System.Drawing.Point(596, 113)
$form.Controls.Add($browse)

$toolsGroup = New-Object System.Windows.Forms.GroupBox
$toolsGroup.Text = "개발 도구 (복수 선택 가능)"
$toolsGroup.Location = New-Object System.Drawing.Point(26, 156)
$toolsGroup.Size = New-Object System.Drawing.Size(670, 224)
$form.Controls.Add($toolsGroup)

$toolDefinitions = @(
  @{ Id = "codex"; Label = "Codex"; Detail = "프로젝트 지침 + Git 게이트" },
  @{ Id = "claude"; Label = "Claude Code"; Detail = "프로젝트 지침 + 작업 전 차단 훅" },
  @{ Id = "antigravity"; Label = "Google Antigravity"; Detail = "규칙 + 작업 전 차단 훅" },
  @{ Id = "claude-desktop"; Label = "Claude Desktop"; Detail = "프로젝트 안내 + Git 게이트" },
  @{ Id = "chatgpt-desktop"; Label = "ChatGPT/Codex Desktop"; Detail = "프로젝트 안내 + Git 게이트" },
  @{ Id = "lovable"; Label = "Lovable + GitHub"; Detail = "TypeScript/PostgreSQL + PR 게이트" }
)
$toolBoxes = @{}
for ($index = 0; $index -lt $toolDefinitions.Count; $index += 1) {
  $item = $toolDefinitions[$index]
  $check = New-Object System.Windows.Forms.CheckBox
  $check.Text = "$($item.Label) — $($item.Detail)"
  $check.Tag = $item.Id
  $check.AutoSize = $false
  $check.AutoEllipsis = $true
  $check.Size = New-Object System.Drawing.Size(630, 26)
  $left = 16
  $top = 26 + (31 * $index)
  $check.Location = New-Object System.Drawing.Point($left, $top)
  $toolsGroup.Controls.Add($check)
  $toolBoxes[$item.Id] = $check
}

$profileLabel = New-Object System.Windows.Forms.Label
$profileLabel.Text = "개발 언어 정책"
$profileLabel.AutoSize = $true
$profileLabel.Visible = $false
$profileLabel.Location = New-Object System.Drawing.Point(26, 378)
$form.Controls.Add($profileLabel)

$profile = New-Object System.Windows.Forms.ComboBox
$profile.DropDownStyle = "DropDownList"
$profile.Location = New-Object System.Drawing.Point(26, 400)
$profile.Size = New-Object System.Drawing.Size(420, 28)
[void]$profile.Items.Add("typescript_web — TypeScript 웹")
[void]$profile.Items.Add("typescript_postgres — Lovable/PostgreSQL 엄격형")
[void]$profile.Items.Add("node_web — JavaScript 웹/API")
[void]$profile.Items.Add("python_internal — Python 업무자동화")
$profile.SelectedIndex = 1
$profile.Visible = $false
$form.Controls.Add($profile)

$policyHint = New-Object System.Windows.Forms.Label
$policyHint.Text = "Lovable을 선택하면 TypeScript/PostgreSQL 엄격형이 자동으로 적용됩니다. Supabase는 선택 가능한 PostgreSQL 연동입니다."
$policyHint.AutoSize = $true
$policyHint.Visible = $false
$policyHint.Location = New-Object System.Drawing.Point(26, 433)
$form.Controls.Add($policyHint)

$policyInfo = New-Object System.Windows.Forms.Label
$policyInfo.Text = "공통 개발 정책: JavaScript · TypeScript · PostgreSQL (자동 적용)"
$policyInfo.AutoSize = $true
$policyInfo.Location = New-Object System.Drawing.Point(26, 398)
$form.Controls.Add($policyInfo)

$apply = New-Object System.Windows.Forms.Button
$apply.Text = "프로젝트에 적용"
$apply.Size = New-Object System.Drawing.Size(150, 34)
$apply.Location = New-Object System.Drawing.Point(26, 430)
$form.Controls.Add($apply)

$status = New-Object System.Windows.Forms.TextBox
$status.Multiline = $true
$status.ReadOnly = $true
$status.ScrollBars = "Vertical"
$status.Location = New-Object System.Drawing.Point(192, 430)
$status.Size = New-Object System.Drawing.Size(504, 120)
$status.Text = "폴더와 도구를 선택한 뒤 적용하세요."
$form.Controls.Add($status)

$browse.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "하네스를 적용할 프로젝트 폴더를 선택하세요"
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $projectPath.Text = $dialog.SelectedPath
    $lock = Get-ProjectLock $dialog.SelectedPath
    if ($null -ne $lock) {
      foreach ($box in $toolBoxes.Values) { $box.Checked = $false }
      foreach ($tool in @($lock.tools)) {
        $mapped = switch ($tool) { "claude-code" { "claude" } "google-antigravity" { "antigravity" } "chatgpt-codex-desktop" { "chatgpt-desktop" } "lovable-github" { "lovable" } default { $tool } }
        if ($toolBoxes.ContainsKey($mapped)) { $toolBoxes[$mapped].Checked = $true }
      }
      $runtimeIndex = @{ "typescript_web" = 0; "typescript_postgres" = 1; "typescript_supabase" = 1; "node_web" = 2; "python_internal" = 3 }[$lock.runtime_profile]
      if ($null -ne $runtimeIndex) { $profile.SelectedIndex = $runtimeIndex }
      $status.Text = "기존 프로젝트 설정을 불러왔습니다. 변경 후 적용하면 하네스 소유 설정만 안전하게 바뀝니다."
    }
  }
})

$toolBoxes["lovable"].Add_CheckedChanged({
  if ($toolBoxes["lovable"].Checked) { $profile.SelectedIndex = 1; $profile.Enabled = $false }
  else { $profile.Enabled = $true }
})

$apply.Add_Click({
  if ($appliedSuccessfully) {
    $form.Close()
    return
  }

  $project = $projectPath.Text.Trim()
  if ([string]::IsNullOrWhiteSpace($project)) {
    [System.Windows.Forms.MessageBox]::Show("프로젝트 폴더를 선택하세요.", "VibeCode Harness", "OK", "Warning") | Out-Null
    return
  }
  $selected = @($toolBoxes.Values | Where-Object { $_.Checked } | ForEach-Object { $_.Tag })
  if ($selected.Count -eq 0) {
    [System.Windows.Forms.MessageBox]::Show("하나 이상의 개발 도구를 선택하세요.", "VibeCode Harness", "OK", "Warning") | Out-Null
    return
  }
  $runtime = ($profile.SelectedItem.ToString().Split(" ")[0])
  if (($selected -contains "lovable") -and $runtime -ne "typescript_postgres") {
    [System.Windows.Forms.MessageBox]::Show("Lovable은 TypeScript/PostgreSQL 엄격형 정책을 사용해야 합니다.", "VibeCode Harness", "OK", "Warning") | Out-Null
    return
  }
  $tools = ($selected -join ",")
  $lock = Get-ProjectLock $project
  $apply.Enabled = $false
  $status.Text = "설정을 적용하고 있습니다…"
  $arguments = if ($null -ne $lock) { @("configure", "--project", $project, "--tools", $tools) } else { @("init", "--project", $project, "--tools", $tools, "--runtime", $runtime, "--level", "L2") }
  $result = Invoke-Harness $arguments
  $apply.Enabled = $true
  if ($result.ExitCode -eq 0) {
    $selectedLabels = @($toolDefinitions | Where-Object { $selected -contains $_.Id } | ForEach-Object { $_.Label }) -join ", "
    $appliedSuccessfully = $true
    $projectPath.ReadOnly = $true
    $browse.Enabled = $false
    foreach ($box in $toolBoxes.Values) { $box.Enabled = $false }
    $status.Text = "적용이 완료되었습니다.`r`n프로젝트: $project`r`n적용된 도구: $selectedLabels`r`n공통 정책: JavaScript · TypeScript · PostgreSQL`r`n`r`n이제 선택한 도구로 개발하세요. 개발이 끝나면 포털에서 서버 보안점검을 요청하세요."
    $apply.Text = "확인 후 닫기"
    $apply.Focus()
  } else {
    $status.Text = "적용하지 못했습니다. 기존 설정은 보존되었습니다.`r`n`r`n$result.Output"
  }
})

[void]$form.ShowDialog()
