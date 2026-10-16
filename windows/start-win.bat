@echo off
REM Buddy for Windows — double-click starter. No admin needed.
REM Needs: Python 3.10+ (python.org, "install for me only"), Ollama + a model.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)

%PY% -c "import requests" >nul 2>nul
if errorlevel 1 (
  echo Installing Buddy's Python pieces (user folder only, no admin)...
  %PY% -m pip install --user -r requirements.txt
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo.
  echo Buddy thinks with free Ollama. Once: install from https://ollama.com/download
  echo then run:  ollama serve   +   ollama pull llama3.2
  echo.
)

%PY% buddy.py
pause
