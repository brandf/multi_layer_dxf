#!/usr/bin/env python3
"""Canonical DXF signature — the reproducible identity of a job's DXF.

Moved here from ~/workspace/v21-verification/run_suite_cli.py
(_dxf_signature), so the CLI, the rerun comparison and the suite all
use the one implementation instead of loosely-copied copies.

Why a signature and not bytes (V2_SCOPE.md §8 Q4): ezdxf writes
$TDCREATE / $TDUPDATE timestamps, random $FINGERPRINTGUID /
$VERSIONGUID values, a timestamped dictionary variable, and the
CLASS order swaps between processes — so two runs of the same
pipeline differ in exactly those bytes. The geometry (modelspace
entities + layers) is the reproducible part. The signature is the
sha256 of the sorted modelspace entities (layer, type, geometry
rounded to 4 decimals) plus the sorted layer names, in exactly the
form the wave-1 harness defined — signatures computed there and
here agree.

Usage: python mldxf_dxf.py <dxf> [<dxf> ...]  — prints one sha256
per file. Import dxf_signature(path) / dxf_equal(a, b) from code.
ezdxf is imported lazily inside dxf_signature(), so importing this
module works on any interpreter; only calling it needs the repo
venv python (ezdxf lives in the repo .venv).
"""

import hashlib
import sys


def dxf_signature(path):
    """Canonical sha256 of a DXF's modelspace geometry + layer names."""
    import ezdxf
    doc = ezdxf.readfile(str(path))
    ents = []
    for e in doc.modelspace():
        d = e.dxf
        t = e.dxftype()
        if t == "CIRCLE":
            ents.append((d.layer, t, round(d.center.x, 4),
                         round(d.center.y, 4), round(d.radius, 4)))
        elif t == "LINE":
            ents.append((d.layer, t, round(d.start.x, 4),
                         round(d.start.y, 4), round(d.end.x, 4),
                         round(d.end.y, 4)))
        elif t == "ARC":
            ents.append((d.layer, t, round(d.center.x, 4),
                         round(d.center.y, 4), round(d.radius, 4),
                         round(d.start_angle, 4), round(d.end_angle, 4)))
        elif t == "LWPOLYLINE":
            ents.append((d.layer, t, tuple(
                (round(x, 4), round(y, 4)) for x, y in e.get_points("xy"))))
        else:
            ents.append((d.layer, t))
    layers = sorted(l.dxf.name for l in doc.layers)
    # NOTE: the two joins are concatenated with no separator between
    # them — that is the wave-1 harness's exact hash input, kept so
    # signatures agree with earlier runs.
    payload = "\n".join(sorted(map(str, ents))) + "\n".join(layers)
    return hashlib.sha256(payload.encode()).hexdigest()


def dxf_equal(path_a, path_b):
    """True when two DXFs have the same canonical signature."""
    return dxf_signature(path_a) == dxf_signature(path_b)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: mldxf_dxf.py <dxf> [<dxf> ...]", file=sys.stderr)
        raise SystemExit(1)
    for arg in sys.argv[1:]:
        print(dxf_signature(arg))
