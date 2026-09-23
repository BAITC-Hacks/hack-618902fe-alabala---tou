@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "QORIT_NO_PAUSE="
if /i "%~1"=="--help" goto help
if /i "%~1"=="--no-pause" set "QORIT_NO_PAUSE=1"
if not "%~1"=="" if not defined QORIT_NO_PAUSE goto usage_error
if not "%~2"=="" goto usage_error
if not defined QORIT_WSL_DISTRO set "QORIT_WSL_DISTRO=Ubuntu-24.04"
if not defined QORIT_PYTHON set "QORIT_PYTHON=/opt/qorit-nemo/bin/python"

echo Installing QORIT in %QORIT_WSL_DISTRO%...
echo Internet access is required. Python packages and speech models take several GB.
echo Existing .env settings and valid speech models are kept.
echo.
where.exe wsl.exe >nul 2>&1
if errorlevel 1 goto missing_wsl

echo [1/3] Checking WSL...
wsl.exe --distribution %QORIT_WSL_DISTRO% --user root --exec /bin/true >nul 2>&1
if not errorlevel 1 goto setup
echo Installing WSL and %QORIT_WSL_DISTRO%. Windows may request administrator rights.
wsl.exe --install --distribution %QORIT_WSL_DISTRO% --no-launch
set "QORIT_EXIT=%ERRORLEVEL%"
if "%QORIT_EXIT%"=="3010" goto reboot
if not "%QORIT_EXIT%"=="0" goto wsl_failed
wsl.exe --distribution %QORIT_WSL_DISTRO% --user root --exec /bin/true
if errorlevel 1 goto wsl_failed

:setup
echo.
echo [2/3] Installing system packages and the Linux Python environment...
wsl.exe --distribution %QORIT_WSL_DISTRO% --user root --cd "%~dp0." --exec bash ./setup_nemo_wsl.sh "%QORIT_PYTHON%"
set "QORIT_EXIT=%ERRORLEVEL%"
if not "%QORIT_EXIT%"=="0" goto failed
echo.
echo [3/3] Preparing models, llama.cpp and checking startup requirements...
wsl.exe --distribution %QORIT_WSL_DISTRO% --cd "%~dp0." --exec "%QORIT_PYTHON%" -u install_project.py
set "QORIT_EXIT=%ERRORLEVEL%"
if not "%QORIT_EXIT%"=="0" goto failed
echo.
echo Installation complete. Run start.cmd and open the address printed by the launcher.
goto finish

:missing_wsl
echo WSL is unavailable. Enable WSL from an administrator terminal:
echo   wsl --install --distribution %QORIT_WSL_DISTRO%
echo See https://learn.microsoft.com/en-us/windows/wsl/install
set "QORIT_EXIT=1"
goto finish

:reboot
echo Windows requires a restart. Restart Windows, then run install.cmd again.
goto finish

:wsl_failed
echo.
echo WSL is not ready. If Windows requested a restart, restart and rerun install.cmd.
echo Otherwise run this command in an administrator terminal and follow its instructions:
echo   wsl --install --distribution %QORIT_WSL_DISTRO%
echo For an existing WSL 1 distribution, convert it with:
echo   wsl --set-version %QORIT_WSL_DISTRO% 2
set "QORIT_EXIT=1"
goto finish

:failed
echo.
echo Installation is incomplete. Fix the error above and rerun install.cmd.
echo Gemma weights must be provided separately; set LLAMA_MODEL_PATH in .env.
echo Setup instructions: README.md
goto finish

:usage_error
echo Usage: install.cmd [--no-pause]
exit /b 2

:help
echo Usage: install.cmd [--no-pause]
echo Installs WSL Ubuntu-24.04, Python dependencies, speech models and llama.cpp.
echo Requires an NVIDIA Windows driver and the Gemma Q4_K_S GGUF model; see README.md.
echo Set QORIT_WSL_DISTRO and QORIT_PYTHON in Windows to override the defaults.
echo --no-pause prevents waiting for a key at the end, including on failure.
exit /b 0

:finish
if not defined QORIT_NO_PAUSE pause
exit /b %QORIT_EXIT%
