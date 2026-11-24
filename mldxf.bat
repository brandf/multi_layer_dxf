@echo off
REM mldxf — headless CLI for multi_layer_dxf (V2.1). Windows double-click use.
REM Usage: mldxf.bat plan container.step -o container_out
REM        mldxf.bat serve   (V2.5 — starts the Bun web server)
REM Runs mldxf.py with the repo .venv python when present (setup_windows.bat
REM creates it); falls back to `python` on PATH. mldxf.py itself is
REM stdlib-only — the .venv python is what the pipeline scripts need.
setlocal
set "HERE=%~dp0"
if exist "%HERE%.venv\Scripts\python.exe" (
  "%HERE%.venv\Scripts\python.exe" "%HERE%mldxf.py" %*
) else (
  python "%HERE%mldxf.py" %*
)
