@echo off
setlocal
cd /d "%~dp0"
echo Collecting diagnostics...
(
  echo JobLedger mail service diagnostics
  echo Date: %DATE% %TIME%
  echo Folder: %CD%
  echo.
  echo [Python in PATH]
  where python
  python --version
  echo.
  echo [Python launcher]
  where py
  py -3 --version
  echo.
  echo [Files]
  dir /b
  echo.
  echo [Config]
  if exist "config.json" (echo config.json: yes) else (echo config.json: no)
  echo.
  echo [Port 8787]
  netstat -ano | findstr ":8787"
) > diagnose.txt 2>&1
notepad diagnose.txt
pause
endlocal
