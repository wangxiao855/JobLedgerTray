@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo JobLedger local mail service
echo ==========================================
echo Folder: %CD%
echo.

set "PY="
python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)

if not defined PY (
  echo [ERROR] Python was not found.
  echo Install Python 3.10 or newer and enable "Add Python to PATH".
  echo https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo Using: %PY%
%PY% --version
echo.

if not exist "config.json" (
  echo [ERROR] config.json not found.
  echo Copy config.example.json to config.json, then fill in your IMAP details.
  echo.
  pause
  exit /b 1
)

echo Starting mail service...
echo Keep this window open while using email sync.
echo Press Ctrl+C to stop.
echo.
%PY% jobledger_mail.py
set "EXITCODE=%ERRORLEVEL%"
echo.
echo Service exited with code %EXITCODE%.
pause
endlocal
