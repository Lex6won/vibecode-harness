# GitHub Pilot Installation and Use

This is the Windows pilot path for people who download `Lex6won/vibecode-harness` directly from GitHub. It is not the future signed institutional installer.

## First installation

1. In GitHub, choose **Code > Download ZIP** for `Lex6won/vibecode-harness`.
2. Extract the ZIP completely.
3. Open PowerShell in the extracted folder. If Windows marks the downloaded script as coming from the Internet, remove that mark first, then run the installer:

```powershell
Unblock-File .\install.ps1
.\install.ps1 -InstallPrerequisites -AllowGitHubPilotSource
```

The installer asks Windows to install Node.js LTS and Python 3.13 for the current user only when they are missing. It installs the checker from the GitHub pilot source, copies the harness to `%LOCALAPPDATA%\Gyeonggi\VibeCodeHarness\github-pilot`, preserves the previous pilot installation as a backup, and runs `gg doctor` after installation.

Users must approve any Windows installer prompt themselves. When `winget` is unavailable, IT support must install Node.js 22 or later and Python 3.11 or later first.

For a harness-only trial, use:

```powershell
.\install.ps1 -SkipChecker -AllowGitHubPilotSource
```

`-SkipChecker` never lets `gg verify` pass a security check. The result remains `checker_incomplete` until the checker is installed.

## Apply to a project

```powershell
& "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd" init `
  --project C:\work\my-service --tools both --runtime typescript_web --level L2

& "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd" start `
  --project C:\work\my-service --brief "Internal civil-service web tool"

& "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd" design `
  --project C:\work\my-service --database no --admin no --external-api no --confirm

& "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd" build --project C:\work\my-service
& "$env:LOCALAPPDATA\Gyeonggi\VibeCodeHarness\github-pilot\gg.cmd" verify --project C:\work\my-service --run-tests
```

`init` applies Codex `AGENTS.md`, Claude Code `CLAUDE.md`, and the Claude pre-tool hook. The executable gate permits Python, JavaScript, and TypeScript only, then checks runtime declarations, policy integrity, tests, and checker evidence. Project source and reports remain on the user PC.

## Pilot update

Pilot installation never updates silently. Download a new GitHub ZIP, extract it to a separate folder, and rerun the same explicit command. Existing pilot files are backed up before replacement. The formal institutional release path must instead use an approved version, SHA-256, signed manifest, and code-signed installer; it must not install from GitHub `main`.
