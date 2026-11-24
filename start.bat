@echo off
REM start.bat — double-click launcher for the mldxf web UI (V2.5).
REM Starts `mldxf serve` (the Bun local server on port 3000) and
REM opens the browser. The server is localhost-only, single user.
REM Usage: double-click, or `start.bat [--port N]`.
setlocal
set "HERE=%~dp0"
if exist "%HERE%.venv\Scripts\python.exe" (
  "%HERE%.venv\Scripts\python.exe" "%HERE%mldxf.py" serve %*
) else (
  python "%HERE%mldxf.py" serve %*
)
