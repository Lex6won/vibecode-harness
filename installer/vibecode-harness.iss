; 기관 배포 관리자가 Inno Setup 6에서 컴파일하는 per-user 설치기 템플릿입니다.
; 실제 배포 전에는 SignTool, timestamp URL, BundlePath를 기관 값으로 전달해야 합니다.
#define AppVersion "0.2.0"
#ifdef DemoBuild
  #define AppName "Gyeonggi VibeCode Harness Demonstration (Unsigned)"
  #define AppId "{{0D1C4E2B-808E-47D4-A4B9-6EA06534CB29}"
  #define DefaultInstallLeaf "VibeCodeHarness-Demo"
  #define OutputBaseFilename "Gyeonggi-VibeCode-Harness-Demo-Unsigned-Setup"
#else
  #define AppName "Gyeonggi VibeCode Harness"
  #define AppId "{{7B91F6D2-92B8-4EE3-9878-2D9487380D10}"
  #define DefaultInstallLeaf "VibeCodeHarness"
  #define OutputBaseFilename "Gyeonggi-VibeCode-Harness-Setup"
#endif
#ifndef BundlePath
  #error BundlePath compiler define is required.
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Gyeonggi\{#DefaultInstallLeaf}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#BundlePath}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\VibeCode Harness Manager"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -File ""{app}\manager.ps1"""; WorkingDir: "{app}"
Name: "{group}\VibeCode Harness 상태 확인"; Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bin\gg.mjs"" doctor"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -File ""{app}\manager.ps1"""; WorkingDir: "{app}"; Description: "VibeCode Harness Manager 시작"; Flags: nowait postinstall skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  if not Exec(
    ExpandConstant('{app}\runtime\node.exe'),
    '"' + ExpandConstant('{app}\bin\gg.mjs') + '" bundle verify --bundle "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('승인 번들 검증 명령을 실행하지 못했습니다. 설치를 계속할 수 없습니다.');

  if ResultCode <> 0 then
    RaiseException('승인 번들 검증에 실패했습니다. 설치 파일의 서명 또는 구성 파일을 확인하세요.');
end;
