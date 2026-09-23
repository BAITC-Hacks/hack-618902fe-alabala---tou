@echo off
setlocal
cd /d "%~dp0"
if not defined QORIT_WSL_DISTRO set "QORIT_WSL_DISTRO=Ubuntu-24.04"
if not defined QORIT_PYTHON set "QORIT_PYTHON=/opt/qorit-nemo/bin/python"
echo Starting QORIT in %QORIT_WSL_DISTRO%...
echo Keep this window open. Press Ctrl+C to stop Gemma and the API.
echo.
wsl.exe --distribution %QORIT_WSL_DISTRO% --cd "%~dp0." --exec "%QORIT_PYTHON%" -u launch_project.py %*
set "QORIT_EXIT=%ERRORLEVEL%"
if not "%QORIT_EXIT%"=="0" (
    echo.
    echo QORIT could not start. See the error above and results\launcher\ logs.
    echo WSL Ubuntu-24.04 and /opt/qorit-nemo/bin/python must be installed.
    echo Setup instructions: README.md and setup_nemo_wsl.sh.
    if "%~1"=="" pause
)
exit /b %QORIT_EXIT%
