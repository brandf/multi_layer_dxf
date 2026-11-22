@echo off
REM Setup for multi_layer_dxf on Windows — run once, from this folder.
REM Requires: Python 3.12 from python.org, installed with
REM "Add python to PATH" checked. No admin rights needed.
REM
REM What it does:
REM   1. checks python is on PATH
REM   2. creates .venv (if missing) and installs build123d + ezdxf
REM   3. smoke-tests the classifier on the synthetic test part
REM      (expect: 8 layers, 6 holes, 3 pockets, 1 flag)
REM
REM After this, run jobs with run_vcarve.bat, e.g.:
REM   run_vcarve.bat container.step container_out

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found on PATH.
  echo Install Python 3.12 from python.org and check "Add python to PATH",
  echo then re-run this script.
  pause
  exit /b 1
)
python --version
if not exist .venv (
  echo Creating .venv ...
  python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install build123d ezdxf
echo.
echo Smoke test: classifying the synthetic test part ...
.venv\Scripts\python.exe step_to_vcarve.py test\test_part.step -o test\out --mode full
echo.
echo Done. Next: run_vcarve.bat your-model.step out-dir
pause
