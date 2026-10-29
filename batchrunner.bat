@echo off
setlocal EnableDelayedExpansion

echo ==============================
echo   Batch Runner
echo ==============================
set /p COUNT=How many folders to run? :

echo.
echo Starting batch files...
echo.

for /L %%i in (1,1,%COUNT%) do (
    if exist "%%i\run.bat" (
        echo Launching folder %%i
        start "Folder %%i" cmd /k "cd /d %%i && run.bat"
    ) else (
        echo Folder %%i or run.bat not found!
    )
)

echo.
echo All requested batch files started.
pause
