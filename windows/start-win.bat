@echo off
REM Buddy for Windows - double-click starter. No admin needed.
REM Needs: Python 3.10+ and Ollama with a model pulled.
REM This file is plain ASCII on purpose so every Windows reads it fine.
cd /d "%~dp0"

set PY=py
where %PY% >nul 2>nul
if errorlevel 1 set PY=python
where %PY% >nul 2>nul
if errorlevel 1 goto nopython
goto checkreq

:nopython
echo.
echo Buddy could not find Python on this PC.
echo Install it free from https://www.python.org/downloads/
echo Then double-click start-win again.
echo.
pause
exit /b 1

:checkreq
%PY% -c "import requests" >nul 2>nul
if not errorlevel 1 goto checkollama
echo.
echo Installing Buddy's Python helper pieces...
echo This goes in your user folder only. No admin needed.
%PY% -m pip install --user -r requirements.txt
if errorlevel 1 goto pipfail
goto checkollama

:pipfail
echo.
echo That install failed. Copy this whole window's text and ask for help.
echo.
pause
exit /b 1

:checkollama
where ollama >nul 2>nul
if not errorlevel 1 goto start
echo.
echo Buddy thinks with free Ollama. One-time setup:
echo   1. Install it: https://ollama.com/download
echo   2. Open the Ollama app so it is running
echo   3. In a terminal run: ollama pull llama3.2
echo No key, no account, no paying. Starting Buddy anyway below.
echo.

:start
%PY% buddy.py
echo.
echo Buddy stopped. Press any key to close this window.
pause
