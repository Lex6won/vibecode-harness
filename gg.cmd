@echo off
setlocal
set "HARNESS_NODE=%~dp0runtime\node.exe"
if exist "%HARNESS_NODE%" (
  "%HARNESS_NODE%" "%~dp0bin\gg.mjs" %*
) else (
  node "%~dp0bin\gg.mjs" %*
)
endlocal
