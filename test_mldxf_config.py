"""Verification for V2.3 (mldxf_config.py) — run: python test_mldxf_config.py

Loads the shipped examples, checks resolve_home / init_home /
placeholder behaviour / empty tools.json, and proves each named
error is rejected with its exact message. Exit 0 only if every
check passes. Prints PASS/FAIL per check plus each rejection's
exact error message.
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mldxf_config as C

PASS = []
FAIL = []


def check(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        FAIL.append(name)
        print(f"FAIL {name}: {exc!r}")
    else:
        PASS.append(name)
        print(f"PASS {name}")


def expect_error(name, fn, needle=None):
    """fn must raise ConfigError; print its exact message."""
    try:
        fn()
    except C.ConfigError as exc:
        msg = str(exc)
        print(f"PASS {name}: rejected with ConfigError:\n     {msg}")
        if needle and needle not in msg:
            FAIL.append(name)
            print(f"FAIL {name}: message lacks {needle!r}")
        else:
            PASS.append(name)
    except Exception as exc:  # noqa: BLE001
        FAIL.append(name)
        print(f"FAIL {name}: wrong exception {exc!r}")
    else:
        FAIL.append(name)
        print(f"FAIL {name}: accepted, expected ConfigError")


def fresh_home():
    tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_"))
    return C.init_home(tmp / "home")


def write(home, filename, obj):
    path = home / filename
    if isinstance(obj, str):
        path.write_text(obj, encoding="utf-8")
    else:
        path.write_text(json.dumps(obj, indent=1), encoding="utf-8")
    return path


def load_json(home, filename):
    return json.loads((home / filename).read_text(encoding="utf-8"))


# --- 1. shipped examples load -------------------------------------------
home = fresh_home()


def t_examples_load():
    m = C.load_machine(home)
    assert m["id"] == "onefinity-elite-foreman", m["id"]
    assert m["bed"] == {"width_mm": 1222.4, "depth_mm": 1222.4}, m["bed"]
    assert m["controller"] == "masso"
    assert m["version"] == 1
    t = C.load_tools(home)
    assert [e["id"] for e in t["tools"]] == [
        "EM6.35", "EM3.17", "EM9.53", "EM0.50", "D2.25"], t
    assert [e["native_label"] for e in t["tools"]] == [
        "1/4in", "1/8in", "3/8in", "0.50 mm", "2.25 mm"], t
    assert [e["dia_mm"] for e in t["tools"]] == [
        6.35, 3.175, 9.525, 0.5, 2.25], t
    cl = C.load_clamps(home)
    assert [e["method"] for e in cl["clamps"]] == [
        "t_track_clamp", "tape", "glue", "screw", "pin"], cl
    assert cl["clamps"][0]["t_track"] is True
    assert all(e["t_track"] is False for e in cl["clamps"][1:])
    p = C.load_preferences(home)
    cfg = json.load(open("config.example.json", encoding="utf-8"))
    assert set(p) == set(cfg) | {"inventory_mode"}, set(p) ^ set(cfg)
    for key, value in cfg.items():
        assert p[key] == value, key
    assert p["inventory_mode"] == "advisory"


check("1. shipped examples load + validate", t_examples_load)


# --- 2. resolve_home ------------------------------------------------------
def t_resolve_home_env():
    os.environ["MLDXF_HOME"] = "/tmp/somewhere-else"
    try:
        assert C.resolve_home() == Path("/tmp/somewhere-else")
    finally:
        del os.environ["MLDXF_HOME"]


def t_resolve_home_default():
    os.environ.pop("MLDXF_HOME", None)
    assert C.resolve_home() == Path.home() / ".config" / "multi_layer_dxf"


check("2a. resolve_home honors MLDXF_HOME", t_resolve_home_env)
check("2b. resolve_home falls back to ~/.config/multi_layer_dxf",
      t_resolve_home_default)


# --- 3. init_home ---------------------------------------------------------
def t_init_home_copies_and_validates():
    tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_init_"))
    got = C.init_home(tmp / "h2")
    assert got == tmp / "h2"
    assert sorted(p.name for p in got.iterdir()) == [
        "clamps.json", "machine.json", "preferences.json", "tools.json"]
    C.load_machine(got)
    C.load_tools(got)
    C.load_clamps(got)
    C.load_preferences(got)


check("3. init_home copies all four + validates", t_init_home_copies_and_validates)


def t_init_home_refuses_overwrite():
    expect_error("3b. init_home refuses to overwrite",
                 lambda: C.init_home(home), "refusing to overwrite")


t_init_home_refuses_overwrite()


# --- 4. placeholder T-track ----------------------------------------------
def t_placeholder_loads_but_refuses():
    m = C.load_machine(home)  # must pass on the example
    assert m["t_track"]["slots"][0]["placeholder"] is True
    expect_error("4. assert_real_t_track refuses placeholders",
                 lambda: C.assert_real_t_track(m),
                 "T-track slots are placeholders — measure your bed")


t_placeholder_loads_but_refuses()


def t_real_t_track_passes_guard():
    m = load_json(home, "machine.json")
    m["t_track"]["placeholder"] = False
    for slot in m["t_track"]["slots"]:
        slot["placeholder"] = False
        del slot["comment"]
    del m["t_track"]["comment"]
    tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_real_"))
    write(tmp, "machine.json", m)
    assert C.assert_real_t_track(C.load_machine(tmp)) is None


check("4b. assert_real_t_track passes once flags are dropped",
      t_real_t_track_passes_guard)


# --- 5. empty tools.json --------------------------------------------------
def t_empty_tools():
    tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_empty_"))
    for variant, content in [
        ("empty file", ""),
        ("bare []", "[]"),
        ("bare {}", "{}"),
        ('{"tools": []}', '{"version": 1, "tools": []}'),
    ]:
        write(tmp, "tools.json", content)
        got = C.load_tools(tmp)
        assert got == {"version": 1, "tools": []}, (variant, got)
        print(f"     empty-tools variant OK: {variant}")


check("5. empty tools.json loads as valid (4 variants)", t_empty_tools)


# --- 6. named rejections --------------------------------------------------
def bad_tools_home(mutate):
    tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
    tools = load_json(home, "tools.json")
    mutate(tools)
    write(tmp, "tools.json", tools)
    return tmp


# 6a. tool dia mismatch vs id
tmp = bad_tools_home(lambda t: t["tools"][0].update(dia_mm=6.0))
expect_error("6a. tool dia_mm != id diameter",
             lambda: C.load_tools(tmp), "does not match the diameter")

# 6b. slot outside the bed
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
m = load_json(home, "machine.json")
m["t_track"]["slots"][0]["at_y_mm"] = 2000.0
write(tmp, "machine.json", m)
expect_error("6b. T-track slot outside the bed",
             lambda: C.load_machine(tmp), "outside the bed")

# 6c. overlapping slots
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
m = load_json(home, "machine.json")
m["t_track"]["slots"].append(
    {"axis": "x", "at_y_mm": 154.0, "from_x_mm": 0, "to_x_mm": 1222.4})
write(tmp, "machine.json", m)
expect_error("6c. overlapping T-track slots",
             lambda: C.load_machine(tmp), "overlap")

# 6d. missing file
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
expect_error("6d. missing machine.json",
             lambda: C.load_machine(tmp), "run 'mldxf init'")
expect_error("6d2. missing tools.json",
             lambda: C.load_tools(tmp), "run 'mldxf init'")

# 6e. unknown key (typo must not silently drop a setting)
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
p = load_json(home, "preferences.json")
p["clamp_margn_mm"] = 20  # typo of clamp_margin_mm
write(tmp, "preferences.json", p)
expect_error("6e. unknown/misspelled preference key",
             lambda: C.load_preferences(tmp), "unknown key")
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
m = load_json(home, "machine.json")
m["bed_width_mm"] = 1222.4
write(tmp, "machine.json", m)
expect_error("6e2. unknown machine key",
             lambda: C.load_machine(tmp), "unknown key")

# 6f. bad JSON
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
write(tmp, "clamps.json", "{not json,,")
expect_error("6f. invalid JSON in clamps.json",
             lambda: C.load_clamps(tmp), "invalid JSON")

# 6g. native label disagreeing with dia_mm
tmp = bad_tools_home(lambda t: t["tools"][0].update(native_label="3/8in"))
expect_error("6g. native_label disagrees with dia_mm",
             lambda: C.load_tools(tmp), "native_label")

# 6h. t_track_clamp with t_track false
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
cl = load_json(home, "clamps.json")
cl["clamps"][0]["t_track"] = False
write(tmp, "clamps.json", cl)
expect_error("6h. t_track_clamp with t_track false",
             lambda: C.load_clamps(tmp), "t_track")

# 6i. guide-time clamp check: t_track clamp, placeholder-only bed
expect_error("6i. guide-time: clamp has no real slot (placeholders)",
             lambda: C.check_clamp_mountable(C.load_clamps(home),
                                             C.load_machine(home)),
             "no real T-track slot")


def t_clamp_mountable_passes_on_real_bed():
    m = load_json(home, "machine.json")
    m["t_track"]["placeholder"] = False
    for slot in m["t_track"]["slots"]:
        slot["placeholder"] = False
    assert C.check_clamp_mountable(C.load_clamps(home), m) is None


check("6i2. guide-time clamp check passes on a real bed",
      t_clamp_mountable_passes_on_real_bed)

# 6j. inventory_mode constraining must not silently behave as advisory
tmp = Path(tempfile.mkdtemp(prefix="mldxf_v23_bad_"))
p = load_json(home, "preferences.json")
p["inventory_mode"] = "constraining"
write(tmp, "preferences.json", p)
expect_error("6j. inventory_mode other than advisory",
             lambda: C.load_preferences(tmp), "advisory")

print()
print(f"{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
print("ALL V2.3 CONFIG CHECKS PASSED")
