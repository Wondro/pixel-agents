@echo off
REM Mock 'codex' executable for Pixel Agents e2e tests (Windows).
setlocal enabledelayedexpansion

set "MOCK_HOME=%HOME%"
if "%MOCK_HOME%"=="" set "MOCK_HOME=%USERPROFILE%"

set "LOG_DIR=%MOCK_HOME%\.codex-mock"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo %DATE% %TIME% codex cwd=%CD% args=%*>> "%LOG_DIR%\invocations.log"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$homeDir=$env:MOCK_HOME; $sessionId='mock-' + [guid]::NewGuid().ToString(); $dir=Join-Path $homeDir '.codex\\sessions\\2026\\01\\01'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $file=Join-Path $dir ('rollout-' + $sessionId + '.jsonl'); $now=(Get-Date).ToUniversalTime().ToString('o'); $cwd=(Get-Location).Path; @{timestamp=$now; type='session_meta'; id=$sessionId; cwd=$cwd} | ConvertTo-Json -Compress | Add-Content -Path $file; @{timestamp=$now; type='event_msg'; payload=@{type='task_started'}} | ConvertTo-Json -Compress | Add-Content -Path $file"

ping -n 31 127.0.0.1 >nul
