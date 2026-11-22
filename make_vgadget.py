#!/usr/bin/env python3
"""Build vcarve/multi_layer_dxf.vgadget from vcarve/multi_layer_dxf.lua.

A .vgadget is just a ZIP with the extension changed: VCarve's
Gadgets > Install New Gadget (or a double-click on the file) extracts
it into Public Documents/Vectric/VCarve Pro/Gadgets/. The .lua goes
in the zip at the root, on its own.
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "vcarve" / "multi_layer_dxf.lua"
OUT = ROOT / "vcarve" / "multi_layer_dxf.vgadget"

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(SRC, SRC.name)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
