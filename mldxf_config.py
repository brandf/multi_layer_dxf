"""Machine config + libraries file model (V2.3).

The operator's real setup lives outside the repo, in a home directory
resolved by :func:`resolve_home` (V2_SCOPE.md §4.1) — never from the
current working directory:

- ``MLDXF_HOME`` environment variable, when set, wins;
- else ``%APPDATA%\\multi_layer_dxf`` on Windows;
- else ``~/.config/multi_layer_dxf``.

Four files live there (the repo ships ``*.example.json`` templates
alongside ``config.example.json``; :func:`init_home` copies them in):

- ``machine.json`` — machine profile: id, name, bed, T-track layout,
  controller (informational in V2 — no post-processor is executed),
  optional default material, version.
- ``tools.json`` — owned-tool inventory, keyed by manifest tool id
  (``EM6.35``, ``D2.25`` — the ids the planner uses).
- ``clamps.json`` — workholding methods the operator actually has.
- ``preferences.json`` — the V1 config values (``config.example.json``
  promoted to a managed file: same keys, same meaning), plus
  ``inventory_mode`` (see below).

Validation (V2_SCOPE.md §4.3) is strict and loud, following the V1
rule: a bad config is a hard error, never a silent default. Every
loader raises :class:`ConfigError` — a distinct exception class with
a human-readable message — on any invalid input, including unknown
or misspelled keys (a typo must not silently drop a setting), a
missing file (which names the exact ``mldxf init`` command that
creates the home), bad JSON, and every cross-check below:

- a tool entry whose ``dia_mm`` does not match its id's diameter
  (``EM6.35`` is 6.35 mm; the id carries two decimals, so a tool
  whose true diameter is 3.175 mm — 1/8 in — has id ``EM3.17`` and
  the check tolerates that 0.005 mm truncation);
- a T-track slot outside the bed, or two same-axis slots overlapping;
- a clamp whose method is ``t_track_clamp`` but whose ``t_track``
  flag is false.

Two checks are deliberately *not* load-time, because they depend on
a pairing that can change after load (V2_SCOPE.md §4.3):

- :func:`assert_real_t_track` — placeholder T-track slots load fine
  (so ``mldxf machine validate`` passes on the shipped example) but
  the workholding guides (V2.9) must refuse them. Call it at
  guide time; it raises ``ConfigError`` naming the measurement the
  operator still owes.
- :func:`check_clamp_mountable` — a clamp with ``t_track: true``
  but no real slot it can mount in is an error at guide time, not
  at load (the bed may change). Call it at guide time.

Inventory is advisory, not constraining (the settled §10 default,
kept as configuration, not hardcoded): ``preferences.json`` may
carry ``inventory_mode: "advisory"`` — the only value V2 accepts —
and nothing in this module hard-fails a plan on an unowned tool.
``tools.json`` may be empty (an empty file, ``[]``, or
``{"tools": []}``), meaning "no inventory recorded yet"; the
planner then behaves exactly as in V1. A *missing* ``tools.json``
is still an error with the ``mldxf init`` hint — missing is not
empty.

This module is deliberately standalone: the parallel V2.1 CLI
(``mldxf``) calls these exact functions, but the module imports
nothing from the pipeline and is importable/testable on its own.
It changes no existing behaviour — no manifest contract, no DXF
output, no gadget, no existing Python tool is touched.
"""

import json
import os
import re
import shutil
from fractions import Fraction
from pathlib import Path

__all__ = [
    "ConfigError",
    "resolve_home",
    "load_machine",
    "load_tools",
    "load_clamps",
    "load_preferences",
    "init_home",
    "assert_real_t_track",
    "check_clamp_mountable",
]

INCH_TO_MM = 25.4

# A tool id's diameter is written to two decimals (EM3.17 is the
# 3.175 mm 1/8 in tool); anything within this of the id is a match.
DIA_TOLERANCE_MM = 0.01

MACHINE_FILENAME = "machine.json"
TOOLS_FILENAME = "tools.json"
CLAMPS_FILENAME = "clamps.json"
PREFERENCES_FILENAME = "preferences.json"

# example file (shipped in the repo, next to this module) -> home file
_EXAMPLES = {
    "machine.example.json": MACHINE_FILENAME,
    "tools.example.json": TOOLS_FILENAME,
    "clamps.example.json": CLAMPS_FILENAME,
    "preferences.example.json": PREFERENCES_FILENAME,
}

_INIT_HINT = "run 'mldxf init' to create it from the shipped examples"

# ---------------------------------------------------------------- errors


class ConfigError(Exception):
    """A named, human-readable config/library error.

    Raised by every loader and check in this module on any invalid
    input. The message always names the file and field at fault, and
    — for a missing file — the exact ``mldxf init`` command that
    fixes it. Never a silent default.
    """


# ---------------------------------------------------------------- home


def resolve_home():
    """Return the library home directory as a :class:`Path`.

    ``MLDXF_HOME`` wins when set and non-blank; else
    ``%APPDATA%\\multi_layer_dxf`` on Windows (falling back to
    ``~/.config/multi_layer_dxf`` if ``APPDATA`` is unset); else
    ``~/.config/multi_layer_dxf``. Never the current working
    directory.
    """
    override = os.environ.get("MLDXF_HOME")
    if override and override.strip():
        return Path(override).expanduser()
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata and appdata.strip():
            return Path(appdata) / "multi_layer_dxf"
    return Path.home() / ".config" / "multi_layer_dxf"


def _home_path(home):
    """Accept ``None`` (resolve), a string, or a :class:`Path`."""
    if home is None:
        return resolve_home()
    return Path(home).expanduser()


def _repo_dir():
    return Path(__file__).resolve().parent


# ---------------------------------------------------------------- helpers


def _is_int(value):
    # bool is an int subclass — a JSON true is not a count/version.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_num(value):
    return (isinstance(value, (int, float))
            and not isinstance(value, bool))


def _check_keys(obj, allowed, required, where):
    """Strict key check: unknown keys and missing required keys fail.

    ``obj`` must be a dict; ``allowed``/``required`` are key sets;
    ``where`` names the location for the error message.
    """
    if not isinstance(obj, dict):
        raise ConfigError(f"{where}: expected an object, got "
                          f"{type(obj).__name__}")
    unknown = sorted(set(obj) - set(allowed))
    if unknown:
        raise ConfigError(
            f"{where}: unknown key(s): {', '.join(unknown)} — "
            f"check for a typo; unknown keys are rejected, never ignored")
    missing = sorted(set(required) - set(obj))
    if missing:
        raise ConfigError(f"{where}: missing required key(s): "
                          f"{', '.join(missing)}")


def _read_json(home, filename):
    """Read and parse a home file, or raise the named errors.

    Missing file -> ConfigError with the ``mldxf init`` hint.
    Bad JSON -> ConfigError carrying the parser's message.
    Empty file -> ``None`` (callers decide whether empty is valid).
    """
    path = _home_path(home) / filename
    if not path.exists():
        raise ConfigError(
            f"{filename} not found in {path.parent} "
            f"(expected at {path}) — {_INIT_HINT}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"{filename}: cannot be read: {exc}") from exc
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{filename}: invalid JSON: {exc}") from exc


def _require_str(obj, key, where):
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{where}: '{key}' must be a non-empty string")
    return value


def _require_num(obj, key, where, minimum=None, exclusive_minimum=False):
    value = obj.get(key)
    if not _is_num(value):
        raise ConfigError(f"{where}: '{key}' must be a number, "
                          f"got {value!r}")
    if minimum is not None:
        if exclusive_minimum and not value > minimum:
            raise ConfigError(f"{where}: '{key}' must be > {minimum}, "
                              f"got {value}")
        if not exclusive_minimum and not value >= minimum:
            raise ConfigError(f"{where}: '{key}' must be >= {minimum}, "
                              f"got {value}")
    return value


def _require_version(obj, where, default=None):
    """A ``version`` integer >= 1; ``default`` when the key is absent."""
    if "version" not in obj:
        if default is None:
            raise ConfigError(f"{where}: missing required key: 'version'")
        return default
    value = obj["version"]
    if not _is_int(value) or value < 1:
        raise ConfigError(f"{where}: 'version' must be an integer >= 1, "
                          f"got {value!r}")
    return value


# ---------------------------------------------------------------- machine


_MACHINE_KEYS = {"id", "name", "bed", "t_track", "controller",
                 "default_material", "version", "post_processor"}
_BED_KEYS = {"width_mm", "depth_mm"}
_T_TRACK_KEYS = {"slot_width_mm", "slots", "placeholder", "comment"}
_SLOT_KEYS_X = {"axis", "at_y_mm", "from_x_mm", "to_x_mm",
                "placeholder", "comment"}
_SLOT_KEYS_Y = {"axis", "at_x_mm", "from_y_mm", "to_y_mm",
                "placeholder", "comment"}


# The native post-processors (V3.6/V3.8) — the ids `mldxf gcode`
# accepts. The AUTHORITY is the TS registry (ts/posts/index.ts
# POSTS); this list mirrors it so `mldxf machine validate` and the
# Preferences/machine-tab UI can reject a typo at save time instead
# of failing at post time. If a post is added to the registry, add
# it here too — test_mldxf_config.py asserts the two lists agree.
KNOWN_POST_PROCESSORS = ("masso-mm", "masso-inch", "grbl", "template")


def _validate_slot(slot, index, width_mm, depth_mm, slot_width_mm):
    where = f"machine.json: t_track.slots[{index}]"
    if not isinstance(slot, dict):
        raise ConfigError(f"{where}: expected an object")
    axis = slot.get("axis")
    if axis not in ("x", "y"):
        raise ConfigError(f"{where}: 'axis' must be 'x' or 'y', "
                          f"got {axis!r}")
    allowed = _SLOT_KEYS_X if axis == "x" else _SLOT_KEYS_Y
    required = {"axis", "at_y_mm", "from_x_mm", "to_x_mm"} \
        if axis == "x" else {"axis", "at_x_mm", "from_y_mm", "to_y_mm"}
    _check_keys(slot, allowed, required, where)
    if "placeholder" in slot and not isinstance(slot["placeholder"], bool):
        raise ConfigError(f"{where}: 'placeholder' must be true/false")
    if "comment" in slot and not isinstance(slot["comment"], str):
        raise ConfigError(f"{where}: 'comment' must be a string")
    # Geometry: the slot must lie inside the bed. A slot outside the
    # bed is an error at machine-validate time (V2_SCOPE.md §4.3).
    if axis == "x":
        at = _require_num(slot, "at_y_mm", where, 0)
        frm = _require_num(slot, "from_x_mm", where, 0)
        to = _require_num(slot, "to_x_mm", where, 0)
        if at > depth_mm:
            raise ConfigError(
                f"{where}: slot runs at y={at} mm, outside the bed "
                f"(depth {depth_mm} mm)")
        if frm >= to:
            raise ConfigError(f"{where}: 'from_x_mm' ({frm}) must be "
                              f"< 'to_x_mm' ({to})")
        if to > width_mm:
            raise ConfigError(
                f"{where}: slot runs to x={to} mm, outside the bed "
                f"(width {width_mm} mm)")
        span = (frm, to)
        fixed = at
    else:
        at = _require_num(slot, "at_x_mm", where, 0)
        frm = _require_num(slot, "from_y_mm", where, 0)
        to = _require_num(slot, "to_y_mm", where, 0)
        if at > width_mm:
            raise ConfigError(
                f"{where}: slot runs at x={at} mm, outside the bed "
                f"(width {width_mm} mm)")
        if frm >= to:
            raise ConfigError(f"{where}: 'from_y_mm' ({frm}) must be "
                              f"< 'to_y_mm' ({to})")
        if to > depth_mm:
            raise ConfigError(
                f"{where}: slot runs to y={to} mm, outside the bed "
                f"(depth {depth_mm} mm)")
        span = (frm, to)
        fixed = at
    return {"axis": axis, "fixed": fixed, "span": span,
            "placeholder": bool(slot.get("placeholder", False))}


def _validate_t_track(t_track, width_mm, depth_mm):
    where = "machine.json: t_track"
    _check_keys(t_track, _T_TRACK_KEYS, {"slot_width_mm", "slots"}, where)
    slot_width = _require_num(t_track, "slot_width_mm", where, 0,
                              exclusive_minimum=True)
    if "placeholder" in t_track \
            and not isinstance(t_track["placeholder"], bool):
        raise ConfigError(f"{where}: 'placeholder' must be true/false")
    if "comment" in t_track and not isinstance(t_track["comment"], str):
        raise ConfigError(f"{where}: 'comment' must be a string")
    slots = t_track["slots"]
    if not isinstance(slots, list):
        raise ConfigError(f"{where}: 'slots' must be a list")
    checked = [_validate_slot(s, i, width_mm, depth_mm, slot_width)
               for i, s in enumerate(slots)]
    # Two slots on the same axis overlap when their centrelines are
    # closer than one slot width AND their spans overlap. Crossing
    # slots (one x, one y) are a normal grid and are not an error.
    for i in range(len(checked)):
        for j in range(i + 1, len(checked)):
            a, b = checked[i], checked[j]
            if a["axis"] != b["axis"]:
                continue
            if abs(a["fixed"] - b["fixed"]) >= slot_width:
                continue
            if a["span"][0] < b["span"][1] and b["span"][0] < a["span"][1]:
                raise ConfigError(
                    f"machine.json: t_track.slots[{i}] and "
                    f"slots[{j}] overlap — two {a['axis']}-axis slots "
                    f"at {a['fixed']} mm and {b['fixed']} mm with "
                    f"slot width {slot_width} mm")
    return checked


def load_machine(home=None):
    """Load and validate ``machine.json`` from the home dir.

    Returns the validated machine dict. A placeholder T-track
    layout loads fine here — see :func:`assert_real_t_track` for
    the guide-time refusal.
    """
    data = _read_json(home, MACHINE_FILENAME)
    if data is None:
        raise ConfigError(f"{MACHINE_FILENAME}: empty file — "
                          f"a machine profile is required; {_INIT_HINT}")
    _check_keys(data, _MACHINE_KEYS,
                {"id", "name", "bed", "t_track", "controller", "version"},
                "machine.json")
    _require_str(data, "id", "machine.json")
    _require_str(data, "name", "machine.json")
    _require_str(data, "controller", "machine.json")
    _require_version(data, "machine.json")
    bed = data["bed"]
    _check_keys(bed, _BED_KEYS, _BED_KEYS, "machine.json: bed")
    width = _require_num(bed, "width_mm", "machine.json: bed", 0,
                         exclusive_minimum=True)
    depth = _require_num(bed, "depth_mm", "machine.json: bed", 0,
                         exclusive_minimum=True)
    if not isinstance(data["t_track"], dict):
        raise ConfigError("machine.json: 't_track' must be an object")
    _validate_t_track(data["t_track"], width, depth)
    if "default_material" in data and data["default_material"] is not None:
        mat = data["default_material"]
        if isinstance(mat, str):
            if not re.fullmatch(r"\d+(\.\d+)?x\d+(\.\d+)?x\d+(\.\d+)?",
                                mat.strip()):
                raise ConfigError(
                    "machine.json: 'default_material' as a string must "
                    f"be 'WxDxT' in mm, got {mat!r}")
        elif isinstance(mat, dict):
            _check_keys(mat, {"width_mm", "depth_mm", "thickness_mm"},
                        {"width_mm", "depth_mm", "thickness_mm"},
                        "machine.json: default_material")
            for key in ("width_mm", "depth_mm", "thickness_mm"):
                _require_num(mat, key, "machine.json: default_material",
                             0, exclusive_minimum=True)
        else:
            raise ConfigError(
                "machine.json: 'default_material' must be null, a "
                f"'WxDxT' string, or an object, got {mat!r}")
    # V3.8: the machine profile names the post (V3_SCOPE.md §6.1/§6.4).
    # Absent or null = no selection (the CLI falls back to its default);
    # a present value must name one of the known native posts. An
    # unknown name is a loud validation error here — never a silent
    # fall-through to the default at post time.
    if "post_processor" in data and data["post_processor"] is not None:
        pp = data["post_processor"]
        if not isinstance(pp, str) or pp not in KNOWN_POST_PROCESSORS:
            raise ConfigError(
                "machine.json: 'post_processor' must be one of "
                f"{', '.join(KNOWN_POST_PROCESSORS)}, got {pp!r}")
    return data


def assert_real_t_track(machine):
    """Refuse placeholder T-track data — guide-time check (V2.9).

    ``machine`` is a dict as returned by :func:`load_machine`.
    Raises :class:`ConfigError` when the T-track layout is a
    placeholder (any slot flagged ``"placeholder": true``, or the
    ``t_track`` object itself flagged so), or when there are no
    slots at all. Returns ``None`` when the layout is real.

    The refusal is driven by the ``placeholder`` flag in the file,
    not hardcoded: replacing the placeholder slots with measured
    ones (and dropping the flag) makes the guides usable with no
    code change. Never guess a slot position.
    """
    if not isinstance(machine, dict) or not isinstance(
            machine.get("t_track"), dict):
        raise ConfigError(
            "T-track slots are placeholders — measure your bed and "
            "replace the placeholder slots in machine.json with your "
            "real measurements")
    t_track = machine["t_track"]
    slots = t_track.get("slots")
    if not isinstance(slots, list) or not slots:
        raise ConfigError(
            "T-track slots are placeholders — measure your bed and "
            "replace the placeholder slots in machine.json with your "
            "real measurements (no slots are defined yet)")
    if t_track.get("placeholder") is True:
        raise ConfigError(
            "T-track slots are placeholders — measure your bed and "
            "replace the placeholder slots in machine.json with your "
            "real measurements")
    for index, slot in enumerate(slots):
        if isinstance(slot, dict) and slot.get("placeholder") is True:
            raise ConfigError(
                "T-track slots are placeholders — measure your bed and "
                "replace the placeholder slots in machine.json with "
                f"your real measurements (slot {index} is a placeholder)")
    return None


# ---------------------------------------------------------------- tools

_TOOL_ID_RE = re.compile(r"^(EM|D)(\d+\.\d+)$")
_NATIVE_LABEL_RE = re.compile(r"^(\d+/\d+)in$|^(\d+(?:\.\d+)?)\s*mm$")

_TOOL_KEYS = {"id", "kind", "dia_mm", "native_label", "feeds", "notes"}
_FEEDS_KEYS = {"feed_mm_s", "plunge_mm_s", "spindle_rpm", "stepdown_mm",
               "stepover_pct"}
_TOOLS_FILE_KEYS = {"version", "tools"}


def _id_diameter(tool_id, where):
    """The diameter encoded in a manifest tool id, e.g. EM6.35 -> 6.35."""
    match = _TOOL_ID_RE.fullmatch(tool_id or "")
    if not match:
        raise ConfigError(
            f"{where}: tool id {tool_id!r} is not a manifest tool id — "
            f"expected 'EM<dia>' for an endmill or 'D<dia>' for a drill, "
            f"e.g. EM6.35, D2.25")
    return float(match.group(2)), match.group(1)


def _check_native_label(label, dia_mm, where):
    """The v1.0.1 rule: the label is the tool's native designation.

    ``"1/4in"`` for an imperial endmill, ``"2.25 mm"`` / ``"0.50 mm"``
    for metric tools and drills — and it must agree with ``dia_mm``,
    so a mislabelled tool is caught instead of silently displayed.
    """
    if not isinstance(label, str) or not label.strip():
        raise ConfigError(f"{where}: 'native_label' must be a non-empty "
                          f"string, e.g. '1/4in' or '2.25 mm'")
    match = _NATIVE_LABEL_RE.fullmatch(label.strip())
    if not match:
        raise ConfigError(
            f"{where}: 'native_label' {label!r} is not a native "
            f"designation — expected e.g. '1/4in' or '2.25 mm'")
    if match.group(1) is not None:
        inches = Fraction(match.group(1))
        labelled_mm = float(inches) * INCH_TO_MM
    else:
        labelled_mm = float(match.group(2))
    if abs(labelled_mm - dia_mm) > DIA_TOLERANCE_MM:
        raise ConfigError(
            f"{where}: 'native_label' {label!r} is "
            f"{labelled_mm:.2f} mm but 'dia_mm' is {dia_mm} mm")


def _validate_tool(entry, where, key_id=None):
    _check_keys(entry, _TOOL_KEYS,
                {"id", "kind", "dia_mm", "native_label"}, where)
    tool_id = entry["id"]
    if key_id is not None and tool_id != key_id:
        raise ConfigError(f"{where}: entry id {tool_id!r} does not match "
                          f"its key {key_id!r}")
    dia_from_id, prefix = _id_diameter(tool_id, where)
    dia = _require_num(entry, "dia_mm", where, 0, exclusive_minimum=True)
    if abs(dia - dia_from_id) > DIA_TOLERANCE_MM:
        raise ConfigError(
            f"{where}: tool {tool_id}: 'dia_mm' {dia} does not match "
            f"the diameter in its id ({dia_from_id} mm) — the id is "
            f"the diameter")
    kind = entry["kind"]
    expected_kind = "endmill" if prefix == "EM" else "drill"
    if kind != expected_kind:
        raise ConfigError(
            f"{where}: tool {tool_id}: 'kind' must be {expected_kind!r} "
            f"for a {prefix} id, got {kind!r}")
    _check_native_label(entry["native_label"], dia, where)
    if "feeds" in entry:
        feeds = entry["feeds"]
        _check_keys(feeds, _FEEDS_KEYS, set(), f"{where}: feeds")
        for key in ("feed_mm_s", "plunge_mm_s", "stepdown_mm"):
            if key in feeds:
                _require_num(feeds, key, f"{where}: feeds", 0,
                             exclusive_minimum=True)
        if "spindle_rpm" in feeds:
            rpm = feeds["spindle_rpm"]
            if not _is_int(rpm) or rpm <= 0:
                raise ConfigError(f"{where}: feeds: 'spindle_rpm' must "
                                  f"be a positive integer, got {rpm!r}")
        if "stepover_pct" in feeds:
            pct = feeds["stepover_pct"]
            if not _is_num(pct) or not 0 < pct <= 100:
                raise ConfigError(f"{where}: feeds: 'stepover_pct' must "
                                  f"be > 0 and <= 100, got {pct!r}")
    if "notes" in entry and not isinstance(entry["notes"], str):
        raise ConfigError(f"{where}: 'notes' must be a string")
    return entry


def load_tools(home=None):
    """Load and validate ``tools.json`` from the home dir.

    Returns a normalized ``{"version": int, "tools": [...]}`` dict
    with one entry per owned tool (entries in file order). Accepts
    the file as a list of entries, as ``{"version": ..., "tools":
    [...]}``, or as ``{"version": ..., "tools": {id: entry}}``
    (entries keyed by id, as V2_SCOPE.md §4.2 describes them).

    An empty inventory is valid: an empty file, ``[]``, ``{}``, or
    ``{"tools": []}`` all mean "no inventory recorded yet" and the
    planner then behaves exactly as in V1. A *missing* file is an
    error with the ``mldxf init`` hint — missing is not empty.
    """
    data = _read_json(home, TOOLS_FILENAME)
    if data is None or data == [] or data == {}:
        return {"version": 1, "tools": []}
    if isinstance(data, list):
        entries, keyed = data, {}
    elif isinstance(data, dict):
        _check_keys(data, _TOOLS_FILE_KEYS, {"tools"}, TOOLS_FILENAME)
        version = _require_version(data, TOOLS_FILENAME, default=1)
        tools = data["tools"]
        if isinstance(tools, list):
            entries, keyed = tools, {}
        elif isinstance(tools, dict):
            entries, keyed = [], tools
        else:
            raise ConfigError(f"{TOOLS_FILENAME}: 'tools' must be a "
                              f"list of entries or an object keyed by id")
        return _finish_tools(entries, keyed, version)
    else:
        raise ConfigError(f"{TOOLS_FILENAME}: expected a list of tool "
                          f"entries or an object with a 'tools' key, "
                          f"got {type(data).__name__}")
    return _finish_tools(entries, keyed, 1)


def _finish_tools(entries, keyed, version):
    seen = set()
    out = []
    for index, entry in enumerate(entries):
        where = f"{TOOLS_FILENAME}[{index}]"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where}: expected an object")
        _validate_tool(entry, where)
        if entry["id"] in seen:
            raise ConfigError(f"{TOOLS_FILENAME}: duplicate tool id "
                              f"{entry['id']!r}")
        seen.add(entry["id"])
        out.append(entry)
    for key in sorted(keyed):
        entry = keyed[key]
        where = f"{TOOLS_FILENAME}: tools[{key!r}]"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where}: expected an object")
        entry = dict(entry)
        entry.setdefault("id", key)
        _validate_tool(entry, where, key_id=key)
        if entry["id"] in seen:
            raise ConfigError(f"{TOOLS_FILENAME}: duplicate tool id "
                              f"{entry['id']!r}")
        seen.add(entry["id"])
        out.append(entry)
    return {"version": version, "tools": out}


# ---------------------------------------------------------------- clamps

_CLAMP_METHODS = {"t_track_clamp", "tape", "glue", "screw", "pin", "vise"}
# Mechanical contact types (Nov 25, 2026 — Brandon: a clamp's
# restraint comes from what it actually contacts, not from sitting
# near an edge). ``top_down`` pushes down from the top at a point
# (hold-down + lateral resistance via friction only); ``edge_push``
# presses against exactly one sheet edge (lateral force on that
# edge only, no hold-down); ``pin`` constrains lateral movement in
# two dimensions at a point (a dowel in a hole — no hold-down).
# A clamp entry may carry ``type`` explicitly; when it does not,
# :func:`clamp_contact_type` infers it from the method (a pin
# method is a pin; a T-track clamp is a top-down hold-down unless
# recorded otherwise). Capacities the balance needs: ``hold_force_n``
# (rated hold-down, top-down), ``lateral_capacity_n`` (rated lateral
# force, edge-push / pin), ``friction_mu`` (per-clamp override of
# the conservative default in mldxf_guides).
_CLAMP_CONTACT_TYPES = {"top_down", "edge_push", "pin"}
_CLAMP_KEYS = {"id", "method", "footprint_mm", "keep_out_mm",
               "hold_force_n", "t_track", "count", "notes",
               "type", "lateral_capacity_n", "friction_mu"}
_CLAMPS_FILE_KEYS = {"version", "clamps"}


def clamp_contact_type(entry):
    """The mechanical contact type of a clamp entry: its explicit
    ``type`` when recorded, else inferred from the method (``pin``
    is a pin; anything else mounts as a top-down hold-down)."""
    t = entry.get("type")
    if t is not None:
        return t
    if entry.get("method") == "pin":
        return "pin"
    return "top_down"


def _validate_clamp(entry, where):
    _check_keys(entry, _CLAMP_KEYS,
                {"id", "method", "footprint_mm", "keep_out_mm",
                 "t_track", "count"}, where)
    _require_str(entry, "id", where)
    method = entry["method"]
    if method not in _CLAMP_METHODS:
        raise ConfigError(
            f"{where}: 'method' must be one of "
            f"{sorted(_CLAMP_METHODS)}, got {method!r}")
    footprint = entry["footprint_mm"]
    if (not isinstance(footprint, list) or len(footprint) != 2
            or not all(_is_num(v) and v > 0 for v in footprint)):
        raise ConfigError(
            f"{where}: 'footprint_mm' must be [width_mm, depth_mm] with "
            f"both > 0, got {footprint!r}")
    _require_num(entry, "keep_out_mm", where, 0)
    if not isinstance(entry["t_track"], bool):
        raise ConfigError(f"{where}: 't_track' must be true/false")
    count = entry["count"]
    if not _is_int(count) or count < 0:
        raise ConfigError(f"{where}: 'count' must be an integer >= 0, "
                          f"got {count!r}")
    if method == "t_track_clamp" and entry["t_track"] is not True:
        raise ConfigError(
            f"{where}: method is 't_track_clamp' but 't_track' is "
            f"false — a T-track clamp mounts in a slot")
    if "hold_force_n" in entry:
        _require_num(entry, "hold_force_n", where, 0,
                     exclusive_minimum=True)
    if "type" in entry and entry["type"] not in _CLAMP_CONTACT_TYPES:
        raise ConfigError(
            f"{where}: 'type' must be one of "
            f"{sorted(_CLAMP_CONTACT_TYPES)}, got {entry['type']!r}")
    if "lateral_capacity_n" in entry:
        _require_num(entry, "lateral_capacity_n", where, 0,
                     exclusive_minimum=True)
    if "friction_mu" in entry:
        _require_num(entry, "friction_mu", where, 0,
                     exclusive_minimum=True)
        if not entry["friction_mu"] <= 1.0:
            raise ConfigError(
                f"{where}: 'friction_mu' must be <= 1.0, got "
                f"{entry['friction_mu']!r}")
    if "notes" in entry and not isinstance(entry["notes"], str):
        raise ConfigError(f"{where}: 'notes' must be a string")
    return entry


def load_clamps(home=None):
    """Load and validate ``clamps.json`` from the home dir.

    Returns a normalized ``{"version": int, "clamps": [...]}`` dict.
    Accepts a list of entries or ``{"version": ..., "clamps":
    [...]}``. An empty file means no clamps recorded (valid, like
    tools); a missing file is an error with the ``mldxf init``
    hint. Note this does NOT check that a ``t_track`` clamp has a
    slot to mount in — that is the guide-time
    :func:`check_clamp_mountable`, because the bed may change
    after load.
    """
    data = _read_json(home, CLAMPS_FILENAME)
    if data is None or data == [] or data == {}:
        return {"version": 1, "clamps": []}
    if isinstance(data, list):
        entries, version = data, 1
    elif isinstance(data, dict):
        _check_keys(data, _CLAMPS_FILE_KEYS, {"clamps"}, CLAMPS_FILENAME)
        version = _require_version(data, CLAMPS_FILENAME, default=1)
        entries = data["clamps"]
        if not isinstance(entries, list):
            raise ConfigError(f"{CLAMPS_FILENAME}: 'clamps' must be a "
                              f"list of entries")
    else:
        raise ConfigError(f"{CLAMPS_FILENAME}: expected a list of clamp "
                          f"entries or an object with a 'clamps' key, "
                          f"got {type(data).__name__}")
    seen = set()
    out = []
    for index, entry in enumerate(entries):
        where = f"{CLAMPS_FILENAME}[{index}]"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where}: expected an object")
        _validate_clamp(entry, where)
        if entry["id"] in seen:
            raise ConfigError(f"{CLAMPS_FILENAME}: duplicate clamp id "
                              f"{entry['id']!r}")
        seen.add(entry["id"])
        out.append(entry)
    return {"version": version, "clamps": out}


def check_clamp_mountable(clamps, machine):
    """Guide-time check: every T-track clamp has a real slot.

    ``clamps`` and ``machine`` are dicts as returned by
    :func:`load_clamps` and :func:`load_machine`. Raises
    :class:`ConfigError` naming the clamp when a clamp with
    ``t_track: true`` has no real (non-placeholder) slot it can
    mount in — because all slots are placeholders, or there are
    no slots at all. Returns ``None`` when every T-track clamp
    has at least one real slot. Non-T-track methods need no slot
    and are never checked here.
    """
    if not isinstance(clamps, dict) or not isinstance(
            clamps.get("clamps"), list):
        raise ConfigError("check_clamp_mountable: expected the loaded "
                          "clamps dict from load_clamps()")
    if not isinstance(machine, dict) or not isinstance(
            machine.get("t_track"), dict):
        raise ConfigError("check_clamp_mountable: expected the loaded "
                          "machine dict from load_machine()")
    slots = machine["t_track"].get("slots")
    real_slots = [s for s in slots
                  if isinstance(s, dict)
                  and s.get("placeholder") is not True] \
        if isinstance(slots, list) else []
    if machine["t_track"].get("placeholder") is True:
        real_slots = []
    for clamp in clamps["clamps"]:
        if not clamp.get("t_track"):
            continue
        if not real_slots:
            raise ConfigError(
                f"clamp {clamp.get('id')!r} needs a T-track slot to "
                f"mount in, but machine "
                f"{machine.get('id')!r} has no real T-track slot — "
                f"its slots are placeholders; measure your bed and "
                f"replace them in machine.json")
    return None


# ---------------------------------------------------------------- preferences

# The V1 config keys (config.example.json), plus the keys V1 code
# actually reads that the example does not carry
# (post_method_overrides, max_drill_mm, stock_size_mm — see
# step_to_vcarve.py / orient_search.py), plus the V2 settled
# default inventory_mode (§10 Q3: advisory, not constraining).
_PREF_KEYS = {
    "clamp_margin_mm", "material", "min_tool_mm", "only",
    "orientation_penalties", "orientation_tie_minutes",
    "pin_clearance_mm", "pin_diameter_mm", "tol_mm", "toolplan",
    "two_sided", "units", "vcarve", "web_min_mm",
    "post_method_overrides", "max_drill_mm", "stock_size_mm",
    "inventory_mode",
}
_PENALTY_KEYS = {
    "flip", "hole_not_from_top", "no_plan", "pocket_not_from_top",
    "post_cnc_3d", "post_decision_needed", "post_drill_press",
    "post_hand_router", "post_router_table",
}
_TOOLPLAN_KEYS = {
    "feed_mm_s", "finish_allowance_mm", "finish_corners",
    "max_corner_radius_mm", "max_plans", "plunge_mm_s", "spindle_rpm",
    "standard_endmills_in", "standard_endmills_mm", "stepdown_mm",
    "stepover_pct", "tabs", "tool_change_seconds",
    # Added by the Nov 21 tool-size cap (toolplan.DEFAULTS); not in
    # config.example.json, but a real V1 knob all the same.
    "max_endmill_ratio", "max_endmill_floor_mm",
}
_TABS_KEYS = {"count", "enabled", "length_mm", "thickness_mm"}
_VCARVE_KEYS = {"gadget_mode", "material_thickness_from_step",
                "post_processor", "z_zero"}
_POST_METHODS = {"cnc_3d", "router_table", "hand_router", "drill_press",
                 "decision_needed"}


def _validate_preferences(data):
    where = PREFERENCES_FILENAME
    _check_keys(data, _PREF_KEYS, set(), where)
    if "clamp_margin_mm" in data:
        _require_num(data, "clamp_margin_mm", where, 0,
                     exclusive_minimum=True)
    if "web_min_mm" in data:
        _require_num(data, "web_min_mm", where, 0)
    if "tol_mm" in data:
        _require_num(data, "tol_mm", where, 0, exclusive_minimum=True)
    if "min_tool_mm" in data:
        _require_num(data, "min_tool_mm", where, 0)
    if "max_drill_mm" in data:
        _require_num(data, "max_drill_mm", where, 0,
                     exclusive_minimum=True)
    if "pin_diameter_mm" in data:
        _require_num(data, "pin_diameter_mm", where, 0,
                     exclusive_minimum=True)
    if "pin_clearance_mm" in data:
        _require_num(data, "pin_clearance_mm", where, 0)
    if "orientation_tie_minutes" in data:
        _require_num(data, "orientation_tie_minutes", where, 0)
    if "two_sided" in data and not isinstance(data["two_sided"], bool):
        raise ConfigError(f"{where}: 'two_sided' must be true/false")
    if "units" in data and data["units"] != "mm":
        raise ConfigError(f"{where}: 'units' must be 'mm', "
                          f"got {data['units']!r}")
    if "material" in data and data["material"] is not None:
        if not isinstance(data["material"], str) or not re.fullmatch(
                r"\d+(\.\d+)?x\d+(\.\d+)?x\d+(\.\d+)?",
                data["material"].strip()):
            raise ConfigError(
                f"{where}: 'material' must be null or a 'WxDxT' string "
                f"in mm, got {data['material']!r}")
    if "stock_size_mm" in data and data["stock_size_mm"] is not None:
        stock = data["stock_size_mm"]
        if (not isinstance(stock, list) or len(stock) != 3
                or not all(_is_num(v) and v > 0 for v in stock)):
            raise ConfigError(
                f"{where}: 'stock_size_mm' must be [W, D, T] in mm with "
                f"all > 0, got {stock!r}")
    if "only" in data and data["only"] is not None:
        only = data["only"]
        if (not isinstance(only, list)
                or not only
                or any(o not in ("drill", "pocket", "profile")
                       for o in only)):
            raise ConfigError(
                f"{where}: 'only' must be null or a list drawn from "
                f"drill/pocket/profile, got {only!r}")
    if "orientation_penalties" in data:
        pens = data["orientation_penalties"]
        _check_keys(pens, _PENALTY_KEYS, _PENALTY_KEYS,
                    f"{where}: orientation_penalties")
        for key, value in pens.items():
            if not _is_num(value) or value < 0:
                raise ConfigError(
                    f"{where}: orientation_penalties: '{key}' must be a "
                    f"number >= 0, got {value!r}")
    if "post_method_overrides" in data:
        overrides = data["post_method_overrides"]
        if not isinstance(overrides, dict):
            raise ConfigError(f"{where}: 'post_method_overrides' must "
                              f"be an object")
        for key, value in overrides.items():
            if value not in _POST_METHODS:
                raise ConfigError(
                    f"{where}: post_method_overrides: {key!r} maps to "
                    f"{value!r}, expected one of {sorted(_POST_METHODS)}")
    if "toolplan" in data:
        tp = data["toolplan"]
        _check_keys(tp, _TOOLPLAN_KEYS, set(), f"{where}: toolplan")
        for key in ("feed_mm_s", "plunge_mm_s", "stepdown_mm"):
            if key in tp and tp[key] is not None:
                _require_num(tp, key, f"{where}: toolplan", 0,
                             exclusive_minimum=True)
        if "finish_allowance_mm" in tp:
            _require_num(tp, "finish_allowance_mm", f"{where}: toolplan",
                         0)
        if "max_corner_radius_mm" in tp and tp["max_corner_radius_mm"] \
                is not None:
            _require_num(tp, "max_corner_radius_mm", f"{where}: toolplan",
                         0, exclusive_minimum=True)
        if "spindle_rpm" in tp:
            rpm = tp["spindle_rpm"]
            if not _is_int(rpm) or rpm <= 0:
                raise ConfigError(f"{where}: toolplan: 'spindle_rpm' "
                                  f"must be a positive integer, got {rpm!r}")
        if "max_plans" in tp:
            if not _is_int(tp["max_plans"]) or tp["max_plans"] < 1:
                raise ConfigError(f"{where}: toolplan: 'max_plans' must "
                                  f"be an integer >= 1, got "
                                  f"{tp['max_plans']!r}")
        if "finish_corners" in tp \
                and not isinstance(tp["finish_corners"], bool):
            raise ConfigError(f"{where}: toolplan: 'finish_corners' "
                              f"must be true/false")
        for key in ("standard_endmills_in", "standard_endmills_mm"):
            if key in tp:
                sizes = tp[key]
                if (not isinstance(sizes, list) or not sizes
                        or not all(_is_num(v) and v > 0 for v in sizes)):
                    raise ConfigError(
                        f"{where}: toolplan: '{key}' must be a non-empty "
                        f"list of positive numbers, got {sizes!r}")
        if "stepover_pct" in tp:
            pct = tp["stepover_pct"]
            if not _is_num(pct) or not 0 < pct <= 100:
                raise ConfigError(f"{where}: toolplan: 'stepover_pct' "
                                  f"must be > 0 and <= 100, got {pct!r}")
        if "tool_change_seconds" in tp:
            _require_num(tp, "tool_change_seconds", f"{where}: toolplan",
                         0)
        if "max_endmill_ratio" in tp:
            ratio = tp["max_endmill_ratio"]
            if not _is_num(ratio) or not 0 < ratio <= 1:
                raise ConfigError(f"{where}: toolplan: "
                                  f"'max_endmill_ratio' must be > 0 and "
                                  f"<= 1, got {ratio!r}")
        if "max_endmill_floor_mm" in tp:
            _require_num(tp, "max_endmill_floor_mm", f"{where}: toolplan",
                         0, exclusive_minimum=True)
        if "tabs" in tp:
            tabs = tp["tabs"]
            _check_keys(tabs, _TABS_KEYS, _TABS_KEYS,
                        f"{where}: toolplan.tabs")
            if not _is_int(tabs["count"]) or tabs["count"] < 0:
                raise ConfigError(f"{where}: toolplan.tabs: 'count' must "
                                  f"be an integer >= 0, got "
                                  f"{tabs['count']!r}")
            if not isinstance(tabs["enabled"], bool):
                raise ConfigError(f"{where}: toolplan.tabs: 'enabled' "
                                  f"must be true/false")
            for key in ("length_mm", "thickness_mm"):
                _require_num(tabs, key, f"{where}: toolplan.tabs", 0,
                             exclusive_minimum=True)
    if "vcarve" in data:
        vc = data["vcarve"]
        _check_keys(vc, _VCARVE_KEYS, set(), f"{where}: vcarve")
        if "gadget_mode" in vc and vc["gadget_mode"] not in (
                "full", "check", "dxf", "manifest"):
            raise ConfigError(f"{where}: vcarve: 'gadget_mode' must be "
                              f"one of full/check/dxf/manifest, got "
                              f"{vc['gadget_mode']!r}")
        if "material_thickness_from_step" in vc and not isinstance(
                vc["material_thickness_from_step"], bool):
            raise ConfigError(f"{where}: vcarve: "
                              f"'material_thickness_from_step' must be "
                              f"true/false")
        if "post_processor" in vc \
                and not isinstance(vc["post_processor"], str):
            raise ConfigError(f"{where}: vcarve: 'post_processor' must "
                              f"be a string")
        if "z_zero" in vc and vc["z_zero"] not in ("top", "bottom"):
            raise ConfigError(f"{where}: vcarve: 'z_zero' must be 'top' "
                              f"or 'bottom', got {vc['z_zero']!r}")
    if "inventory_mode" in data and data["inventory_mode"] != "advisory":
        # The settled §10 default, kept as config: V2 only knows
        # advisory. A "constraining" value must not silently behave
        # as advisory, so it is an error, not a default.
        raise ConfigError(
            f"{where}: 'inventory_mode' must be 'advisory' in V2 "
            f"(tool inventory is informational, not constraining), "
            f"got {data['inventory_mode']!r}")
    return data


def load_preferences(home=None):
    """Load and validate ``preferences.json`` from the home dir.

    Returns the validated preferences dict. Accepts every key in
    ``config.example.json`` (same keys, same meaning — this file is
    that config promoted to a managed file), plus
    ``post_method_overrides``, ``max_drill_mm``, ``stock_size_mm``
    (keys V1 code reads), plus ``inventory_mode``. Unknown keys
    are errors. When ``inventory_mode`` is absent the documented
    default ``"advisory"`` is filled in on the returned dict.
    """
    data = _read_json(home, PREFERENCES_FILENAME)
    if data is None:
        raise ConfigError(f"{PREFERENCES_FILENAME}: empty file — "
                          f"preferences are required; {_INIT_HINT}")
    if not isinstance(data, dict):
        raise ConfigError(f"{PREFERENCES_FILENAME}: expected an object, "
                          f"got {type(data).__name__}")
    _validate_preferences(data)
    data.setdefault("inventory_mode", "advisory")
    return data


# ---------------------------------------------------------------- init


def init_home(home=None):
    """Copy the shipped example files into the home dir.

    Creates the home dir if needed, then copies
    ``machine.example.json`` -> ``machine.json``,
    ``tools.example.json`` -> ``tools.json``,
    ``clamps.example.json`` -> ``clamps.json`` and
    ``preferences.example.json`` -> ``preferences.json``. Refuses
    to overwrite an existing file (raises :class:`ConfigError`
    naming it, before copying anything). Returns the home
    :class:`Path`. The copied files are validated on the way out,
    so a broken shipped example fails here instead of later.
    """
    home = _home_path(home)
    repo = _repo_dir()
    for example, target in _EXAMPLES.items():
        if not (repo / example).exists():
            raise ConfigError(
                f"init: shipped example {example} is missing from the "
                f"repo ({repo}) — cannot initialise {home}")
    existing = [t for t in _EXAMPLES.values() if (home / t).exists()]
    if existing:
        raise ConfigError(
            f"init: refusing to overwrite existing file(s) in {home}: "
            f"{', '.join(existing)} — edit them in place, or move them "
            f"aside and run 'mldxf init' again")
    home.mkdir(parents=True, exist_ok=True)
    for example, target in _EXAMPLES.items():
        shutil.copyfile(repo / example, home / target)
    # Prove the copy validates — a broken example fails here.
    load_machine(home)
    load_tools(home)
    load_clamps(home)
    load_preferences(home)
    return home
