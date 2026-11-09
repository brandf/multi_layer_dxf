@echo off
REM Run the multi-part classifier on Windows — one machine, no file shuffling.
REM Usage:
REM   run_vcarve.bat scene.step outdir
REM Example:
REM   run_vcarve.bat container.step container_out
REM
REM This runs multi_part.py with --auto: it decides each part's CAM
REM orientation (prismatic axis to Z, best side up), bottom-aligns,
REM lays parts side by side, and writes outdir\<name>.dxf,
REM outdir\manifest.json, outdir\manifest.txt and outdir\report.md.
REM Read report.md before opening anything in VCarve.
REM
REM For a single part, or to check without writing files:
REM   .venv\Scripts\python.exe step_to_vcarve.py part.step -o out --mode check

if "%~1"=="" (
  echo Usage: run_vcarve.bat scene.step outdir
  exit /b 1
)
if "%~2"=="" (
  echo Usage: run_vcarve.bat scene.step outdir
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo No .venv found here. Run setup_windows.bat first.
  exit /b 1
)
.venv\Scripts\python.exe multi_part.py "%~1" -o "%~2" --auto
