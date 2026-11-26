# V3.7a — VCarve `.pp` evaluation plan

Owner: V3.7a prep. Status: **PREP ONLY — evaluation BLOCKED, no findings yet.**
Date: 2026-11-25. Gate: V3_SCOPE.md §6.3 ("the gate is the evaluation,
not enthusiasm"). Depends on: V3.6 (native posts, round-trip) + V3.8
(`mldxf gcode --verify`) + Brandon's two `.pp` files (§7 below).

This document is the complete, executable plan for the V3.7a evaluation.
It contains **no evaluation findings**: the two `.pp` files have not
arrived, no `.pp` file has been read, and nothing here claims what the
Masso files contain. Everything in §1–§6 is either (a) a checklist to
run against the files when they land, or (b) a fact about this repo's
existing machinery that the evaluation will use. The one external
source used to ground the catalogue categories is Vectric's published
*Post Processor Editing* guide (V11.5 Aspire, ENU,
`docs.vectric.com/docs/V11.5/Aspire/ENU/Help/form/post-processor-editing/index.html`,
read 2026-11-25) — it describes the `.pp` format in general, not the
two Masso files. Where that guide and the scope doc differ, §1.8 says
so and the files decide.

**Judgment call (code vs document, recorded): this wave ships the
document only, no harness code.** A construct cataloguer written now
could only be tested against synthetic fragments written by the same
person who wrote the cataloguer — it would test my assumptions about
the format, not the format, and it would be one quiet step toward
designing the interpreter that V3.7b is forbidden to design before
the evaluation. The honest assessment is that no code can be validated
without the files. The evaluation worker builds its tooling (a line
classifier, at most) against the real files, in the evaluation run.

## 0. What the evaluation must answer, in one paragraph

Read the two Masso `.pp` files Brandon supplies (Onefinity Masso
(inch) Latest V6, (mm) Latest V3) and catalogue every construct they
use. Answer, in writing: **what subset of the `.pp` format covers
those two files, and is that subset a sane bounded language (bounded,
no file/network access, no arbitrary code) or is it the full macro
language in disguise?** The answer gates V3.7b: build the subset
interpreter only if §5's test passes in full; otherwise native posts
are the path and `.pp` stays a documented non-goal. A `.pp` is user
code; its output is verified like any other post's (§6).

## 1. The construct catalogue — checklist to build from the two files

Method: classify **every line** of each file into exactly one row
below. A line that fits no row is an **UNKNOWN** — it is recorded
verbatim (line number + text) and it alone can fail the gate (§5,
criterion 1). The catalogue is complete only when UNKNOWN = 0 in
both files. Counts are reported per file and per category, with the
distinct values used (e.g. which `VAR`s, which blocks, which format
strings), not just totals.

Categories are grounded in Vectric's published guide where marked
`[Vectric]`; categories marked `[check]` are things the scope doc
names, or that the guide does *not* show, which the evaluation must
confirm present-or-absent in the files rather than assume.

### 1.1 File comments and structure

| # | Construct | What to record | What it would mean for the interpreter |
|---|---|---|---|
| 1.1.1 | Comment lines starting with `+` or `\|` [Vectric] | Count; whether the History block names the file's version / author / edits | Nothing executable. **Keep the History block**: it is the evidence for whether the file is stock Onefinity or Brandon-customised (§7). A file whose History says "modified" needs the modification lines identified. |
| 1.1.2 | Blank lines / whitespace | Count | Ignored. If a blank line inside a `begin` block is significant to VCarve, record it — do not assume. |
| 1.1.3 | `begin <BLOCK>` … quoted command lines [Vectric] | Every block name used, in file order, with its line span | The block inventory (§1.5) is the interpreter's dispatch table. A block name not in §1.5 is UNKNOWN. |

### 1.2 Global file statements (appear once, file scope)

[Vectric] — statement names in upper case. Record the exact value of
each one present; record ABSENT for each one not present.

| # | Statement | What it would mean for the interpreter |
|---|---|---|
| 1.2.1 | `POST_NAME="…"` | Identity only. Must match the file Brandon named (§7). The interpreter reports it; it never affects motion. |
| 1.2.2 | `FILE_EXTENSION="…"` | Output filename suffix (expect `nc`/`tap`/`gcode` — record what it actually is). Mechanical. |
| 1.2.3 | `UNITS="MM"` / `"INCHES"` | **Load-bearing.** Must agree with the file's inch/mm identity, and the interpreter must emit G21/G20 to match. A file whose UNITS disagrees with its name is a finding, not a typo to smooth over. |
| 1.2.4 | `LINE_ENDING="[13][10]"` (or other) | Mechanical: line terminator of the output. Record the exact value. |
| 1.2.5 | `LINE_NUMBER`, `LINE_NUMBER_INCREMENT`, `LINE_NUMBER_MAXIMUM` | Block numbering (§1.6). Mechanical state: a counter, start/increment/max with wraparound. If present, the interpreter implements exactly that counter; if absent, no `[N]` output. |
| 1.2.6 | `SPINDLE_SPEED_RANGE = a b c d` | Spindle speed remapped to an integer range. **Load-bearing if present**: the interpreter must apply the same mapping, and the round-trip must still verify (the parser sees the remapped S). If present, the evaluation must state the mapping and confirm the native-post limit check (`maxSpindleRpm`, docs-v3/gcode.md §2) still applies to the *actual* rpm, not the remapped integer. |
| 1.2.7 | `SUBSTITUTE = "O1 S1 …"` (character pairs) | Post-output character substitution (e.g. `()` → `{}`). Mechanical string rewrite applied after variable substitution. Record the exact pairs; a pair that rewrites a character inside a G-code word (not just inside a tool-name comment) is a finding. |
| 1.2.8 | `MIN_ARC_RADIUS`, `MAX_ARC_RADIUS` | **Load-bearing.** Arcs below the minimum become a straight line; arcs above the maximum are polygonised. The interpreter must reproduce exactly that decision (same thresholds, same replacement), because it changes the moves. The round-trip (§6) is the check that it did — but the evaluation must record the thresholds and which reference-job arcs they affect. |
| 1.2.9 | `RAPID_PLUNGE_TO_STARTZ="YES"` | Plunge moves to the plunge (Z2) height are rapids. Changes rapid/feed classification of Z-only moves. Record present/absent; if present, the interpreter's move classification must follow it, and the round-trip must confirm no rapid crosses stock. |
| 1.2.10 | `ROTARY_WRAP_X` / `ROTARY_WRAP_Y` | Rotary wrapping (an axis becomes A/B). **If present and load-bearing, the gate fails** (§5, criterion 6): our move model has no rotary axis and the sim cannot verify wrapped output. Record present/absent. |
| 1.2.11 | `INVERSE_TIME_MODE="YES"` | Feed in inverse-time mode (G93). **If present and load-bearing, the gate fails**: `ts/gcode_parse.ts` refuses G93/G95, so the output could never round-trip-verify (§6). Record present/absent. |
| 1.2.12 | `LASER_SUPPORT="YES"` | Laser toolpaths supported. If present, record whether any laser block is actually used in the file; mere presence with no laser block is inert, presence *with* a `JET_*` block is a finding (§1.5). |
| 1.2.13 | `PRINT_DIRECT`, `DIRECT_OUTPUT` | Direct output to a driver/document interface. **If present, the gate fails**: that is output outside the file the interpreter returns (§5, criterion 6). Record present/absent. |
| 1.2.14 | `TAPE_SPLITTING=…` | Long output split into multiple numbered files. **If present and active, the gate fails as stated**: the interpreter contract is one file in, one file out (§5, criterion 6). Record present/absent and the parameters; if present but provably inert (e.g. max lines above any real job's output), say so with the numbers. |
| 1.2.15 | `POST_BASE` | **No longer supported** per Vectric's own guide (inheritance from another post). If present, the evaluation refuses to evaluate the file as self-contained: the covering subset would include another file's contents. Record present/absent; present = gate fails unless the base file is also supplied and catalogued as part of the same evaluation. |
| 1.2.16 | Any other `UPPER_CASE = …` statement | UNKNOWN until classified. Do not fold an unfamiliar statement into a neighbouring row. |

### 1.3 Variables — definition and use

The `.pp` variable system [Vectric]:

- **Definition:** `VAR <NAME> = [<VO>|<WO>|<CS>|<VF>|<MX>]` where `VO` =
  variable output label (e.g. `X`, `F`, `S`), `WO` = when output
  (`A` always, `C` only when changed), `CS` = character string
  printed before the value, `VF` = value format (`FORMAT_FLAGS
  FIELD_WIDTH DECIMAL_SEPARATOR DECIMAL_PLACES`), `MX` = multiplier.
- **Use:** the `[VO]` label inside a quoted command line is replaced
  by the current value, formatted per that variable's `VAR`
  definition; a variable used with no `VAR` definition takes its
  documented default format.
- **Format flags** [Vectric]: `-` left-justify, `+` always sign,
  `0` zero-pad, `#` always print the separator. Field width is a
  minimum character count; decimal separator is usually `.`;
  decimal places are typically 3 (mm) / 4 (inch).
- **Special characters** [Vectric]: `[91]` `[`, `[93]` `]`, `[34]`
  `"`, `[13]` CR, `[10]` LF — an ASCII code in brackets outputs
  that character. This is how a line ending and literal brackets
  are produced; it is also the only way the format can emit a
  character outside the quoted text.

Checklist — for **each** `VAR` definition and **each** `[…]` use in
both files:

| # | Item | What to record | What it would mean for the interpreter |
|---|---|---|---|
| 1.3.1 | Every `VAR` definition: name, VO, WO, CS, VF (flags/width/separator/places), MX | Full table per file | This table *is* the formatting spec the interpreter implements. A `VAR` whose VO has no value source in §1.4 is a finding (see 1.4.3). |
| 1.3.2 | Every `[VO]` use: which block, which line, which variable | Use-count per variable | An unused `VAR` definition is inert (record it, do not implement it). A used variable with no definition takes the documented default — record the default the evaluation assumes, with the guide as the source. |
| 1.3.3 | `WO=C` ("only when changed") uses | Which variables are modal-suppressed | **Stateful.** The interpreter must keep the last-emitted value per such variable and suppress repeats — exactly VCarve's modal behaviour. This is the format's only conditional-output mechanism in the published guide (see §1.8). A wrong "changed" comparison (e.g. comparing formatted text vs raw value, or comparing across tool changes when VCarve resets) silently drops or duplicates words — the round-trip (§6) is the only check, so the evaluation must state the comparison rule it observed or, if unobservable from the files, flag it as an assumption V3.7b must test against VCarve-posted output (§6.4). |
| 1.3.4 | Multipliers `MX` (e.g. `0.01666` feed/min→/sec, `-1` sign flip, `57.2957795` rad→deg, `0.25` scale) | Every multiplier value and its variable | Pure arithmetic on output. **A multiplier that is not a unit conversion is a finding**: a scale factor (e.g. `0.25`) changes the cut geometry and must be justified from the file, never normalised away. Record each multiplier's purpose in one line. |
| 1.3.5 | Format flags / field width / decimal separator / decimal places per variable | Exact strings | Mechanical formatting. Decimal places are the rounding the round-trip band must absorb (docs-v3/gcode.md §7: inch posts round to 0.0001 in = 0.00254 mm). If any variable uses a comma decimal separator or a field width that truncates, record it as a finding — truncation is silent data loss. |
| 1.3.6 | Special-character codes `[13]`, `[10]`, `[91]`, `[93]`, `[34]`, any other `[<number>]` | Every numeric code used | Mechanical. Any `[<number>]` outside the documented set is UNKNOWN. Note: `[13][10]` is the line ending (§1.2.4), not a variable. |
| 1.3.7 | String variables: `[TOOLNAME]`, `[TOOL_NOTES]`, `[TOOLPATH_NAME]`, `[TP_FILENAME]`, `[TP_DIR]`, `[TP_EXT]`, `[PATHNAME]`, `[TOOLPATH_NOTES]`, `[FILE_NOTES]`, `[TOOLS_USED]`, `[TOOLPATHS_OUTPUT]` | Each use, and whether it lands in a comment or in a motion/control line | **The supply question (§1.4).** A string variable in a comment is harmless; the same variable in a control line (or in a line the Masso parses) needs a defined value or a refusal. |

### 1.4 Variable values — what the interpreter can actually supply

For every variable used in either file, classify its value source.
This is the catalogue's most important table: a motion-affecting
variable with no source is a gate failure (§5, criterion 3).

| Source | Variables it supplies | Notes |
|---|---|---|
| **A. The move itself** (from `job.json` `toolpaths`, the same moves the native posts consume — `ts/posts/common.ts` `JobIn`) | `[X] [Y] [Z]` position, `[I] [J]` incremental arc centre, `[IA] [JA]` absolute arc centre, `[ArcStartX/Y]`, `[ArcMidX/Y]`, `[ArcMidXI/YI]`, `[Radius]`, `[Angle]`, `[F]`/`[FC]`/`[FP]` feed/cut/plunge rate, `[S]` spindle speed, `[T]` tool number, `[TP]` previous tool number, `[N]` line number | Z needs the native-post conversion first: the `.pp`'s `[Z]` is a *machine* Z, so the interpreter must feed it `machineZ = jobZ − stockTop` (docs-v3/gcode.md §3), never the raw job Z. The evaluation must record what Z convention the Masso files assume (header G-codes, any Z offset) and confirm the conversion applies — see §1.7. Arc centre: record whether the files use incremental `[I]/[J]` or absolute `[IA]/[JA]`; our parser handles incremental (incl. helical) — absolute centres must be converted or refused. |
| **B. The job** (`job.json` + config snapshot + `machine.json`) | `[SAFEZ]` (clearance), `[XLENGTH]/[YLENGTH]/[ZLENGTH]`, `[XMIN]/[YMIN]/[ZMIN]`, `[XMAX]/[YMAX]/[ZMAX]` (material extents), `[XH]/[YH]/[ZH]` (home), `[X_ORIGIN_POS]/[Y_ORIGIN_POS]/[Z_ORIGIN]`, `[TDIA]` tool diameter, `[DWELL]` dwell time | Each of these needs a *defined mapping* to a job field, written down in the evaluation. Material extents come from the sheet/job geometry; home is the machine profile's (record what the native posts use — if the native posts have no home concept, the evaluation must say where `[XH]/[YH]/[ZH]` values come from or refuse the variable). A variable whose job mapping is "obvious" but unwritten is a finding, not a pass. |
| **C. The post file itself** | `POST_NAME`, `FILE_EXTENSION`, `UNITS`, line-number state, `SPINDLE_SPEED_RANGE` mapping | Self-contained. No external input. |
| **D. VCarve-only state — no source in this tool** | `[TOOLPATH_NAME]`, `[TOOLPATH_NOTES]`, `[FILE_NOTES]`, `[TOOL_NOTES]` (free text), `[TP_FILENAME]`, `[TP_DIR]`, `[TP_EXT]`, `[PATHNAME]`, `[TOOLS_USED]`, `[TOOLPATHS_OUTPUT]`, `[DATE]`, `[TIME]`, `[PRODUCT]` | **Rule:** if such a variable appears only inside a `(…)` comment, it is inert *provided* the interpreter emits a defined placeholder or omits the comment — record the choice. If it appears in a control line, or its value affects motion, the gate fails for that file. `[DATE]`/`[TIME]` anywhere in the output also break determinism (same job → different bytes on re-post, violating docs-v3/gcode.md §7); the evaluation must state where they appear and the V3.7b handling (comment-only + stripped, or refuse). `[TOOL_NOTES]` is free text from VCarve's ToolDB — it is untrusted input even inside VCarve; inside our interpreter it must never be emitted unescaped into a control line. |
| **E. No source, no mapping** | Anything used but not in A–D | Gate fails (§5, criterion 3). List it by name. |

### 1.5 Blocks — the dispatch table

[Vectric] block inventory. For each file, record: present/absent,
line span, number of command lines, and (for move blocks) which
move kinds trigger it. The interpreter's execution model is: walk
the toolpath moves in order; at each event, emit the matching
block's lines with variables substituted. A block whose trigger
the evaluation cannot state is UNKNOWN.

| Block | Trigger (per the guide) | Interpreter implication |
|---|---|---|
| `HEADER` | Once, at the start of the file | Setup/modals (G20/G21, G90, G17, units). Must agree with the native posts' header contract (docs-v3/gcode.md §2) on units + Z-zero statement. |
| `SPINDLE_ON` | When the spindle first turns on | Usually `M3` + `[S]`. If the Masso files put spindle-on in the header instead, record that — do not assume this block exists. |
| `TOOLCHANGE` | On a change of tool (not the initial selection) | `T<n> M6` + manual-change behaviour for the Masso (no ATC). Must match the native post's tool-change semantics; any `G43` here is a finding — the native posts never emit G43 (Masso does not support it) and the parser refuses it, so a `.pp` emitting G43 could never verify (§6). |
| `NEW_SEGMENT` | New toolpath with the *same* tool number (e.g. different spindle speed) | Needs a "same tool, new operation" event from the move stream. Our moves carry `operation` per move (`ts/posts/common.ts`), so the event is definable — the evaluation must state the exact trigger in our terms (operation change? feed/spindle change?). A tool change also calls NEW_SEGMENT per the guide — record whether the files rely on that. |
| `INITIAL_RAPID_MOVE` | The very first rapid after header/tool change | First-move special case. State. If present, the interpreter needs a first-rapid flag; if absent, rapids are uniform. |
| `RAPID_MOVE` | Every rapid move | Maps to native `rapid`. |
| `FIRST_FEED_MOVE` | First feed move in a series | Feed-rate establishment. State whether the Masso files use it (it changes where `[F]` first appears). |
| `FEED_MOVE` | Every feed move (except the first, if FIRST_FEED_MOVE exists) | Maps to native `linear` / `plunge` (Z-only feed = plunge feed — docs-v3/gcode.md §1). |
| `FIRST_CW_ARC_MOVE`, `CW_ARC_MOVE` | First / subsequent clockwise arc moves | Maps to native `arc` (cw). |
| `FIRST_CCW_ARC_MOVE`, `CCW_ARC_MOVE` | First / subsequent counter-clockwise arc moves | Maps to native `arc` (ccw). |
| `FIRST_CW_HELICAL_ARC_MOVE`, `CW_HELICAL_ARC_MOVE` | CW helical arcs (arc + Z change) | Our moves carry helical arcs (parser: helical I/J, docs-v3/gcode.md §8). Record whether the files distinguish helical from planar arcs — if they do, the interpreter must too; if they don't, record that the same block serves both. |
| `FIRST_CCW_HELICAL_ARC_MOVE`, `CCW_HELICAL_ARC_MOVE` | CCW helical arcs | As above. |
| `FIRST_CW_HELICAL_ARC_PLUNGE_MOVE`, `FIRST_CCW_HELICAL_ARC_PLUNGE_MOVE` | First helical arc *plunge* in a series | Feed from the plunge rate per the guide. If present, the interpreter needs the plunge-vs-feed distinction on helical arcs — record it. |
| `FIRST_PLUNGE_MOVE`, `PLUNGE_MOVE` | First / subsequent plunge (Z-only feed) moves | Maps to native `plunge`. Record whether the files distinguish plunge from feed at all — the V3.1 generator's ramps are helical arcs, not plunges, so this block may be near-dead on our moves; the evaluation says so with the move counts. |
| `RETRACT_MOVE` | Retract moves | Z-only rapid/feed upward. State the trigger in our terms (a rapid to clearance? any +Z feed?). If the files' retract block fires on events our move stream does not distinguish, that is a finding. |
| `DWELL_MOVE` | Drilling dwell (VCarve 7.5+; `[DWELL]` seconds) | **Parser gap**: `ts/gcode_parse.ts` refuses G4 (docs-v3/gcode.md §8). If the Masso files emit a dwell, the output cannot round-trip-verify as-is — the evaluation records it and §5 criterion 4 fails unless the dwell is provably absent from our jobs (our drills are explicit pecks with no dwell — state the fact with the move evidence) or the parser gains G4 first (a scoped V3.7b prerequisite, not a silent pass). If the block is absent, dwell is a non-issue. |
| `FEED_RATE_CHANGE` | When the feed rate changes | Rare; if present, the interpreter needs a feed-change event. Record. |
| `FOOTER` | Once, at the end of the file | Spindle off, park, `M30`. Must agree with the native footer. |
| `JET_TOOL_POWER`, `JET_TOOL_ON`, `JET_TOOL_OFF` | Laser/plasma/waterjet power events | **If any is present with command lines, the gate fails for that file**: we have no jet tools and no sim model for them. Present-but-empty is inert; record which. |
| Any other `begin <X>` | — | UNKNOWN. |

### 1.6 Line numbering, tape splitting, output shape

| # | Item | What to record |
|---|---|---|
| 1.6.1 | `[N]` uses + `LINE_NUMBER*` statements | Start/increment/maximum; wraparound behaviour at maximum (per the guide, cycles to start). The interpreter's counter must reproduce it, including whether `[N]` appears on every line or only some. |
| 1.6.2 | `TAPE_SPLITTING` | See §1.2.14. If active, record the split parameters and the line count at which the reference jobs would split — a split output is multiple files, which the `gcode` job entry (one file per post run, docs-v3/job_model_v3.md §6.1) cannot represent. |
| 1.6.3 | Output line count per reference job | Measured in §4 by actually posting (once V3.7b exists) — the evaluation *predicts* the bound from the catalogue (moves × max lines per move block + header/footer) and V3.7b *measures* it. The prediction is written here, in the evaluation, before any interpreter exists. |
| 1.6.4 | Non-G-code output | If any block emits HPGL or other non-G-code (the format supports it — the guide's example shows HPGL), record it. Non-G-code output cannot round-trip through `gcode_parse.ts` (§6) — gate fails for that file. |

### 1.7 The Z convention and units — a dedicated check, not a row

The native posts convert `machineZ = jobZ − stockTop` (job Z=0 at
the stock bottom; machine Z-zero at the top of the material,
docs-v3/gcode.md §3). The evaluation must establish, from the
files themselves (header G-codes, comments, `[Z]` formatting,
`[Z_ORIGIN]` use), what Z convention the Masso `.pp` files assume
and confirm the same conversion applies before `[Z]` is
substituted. Specifically record:

1. Does the header emit G20/G21 matching the file's UNITS?
2. Is there any Z offset, shift, or `G54`–`G59` work offset in the
   header/toolchange that would move Z-zero away from the stock
   top?
3. Does any block emit an absolute Z word that is *not* the
   tool position (e.g. a clearance height from `[SAFEZ]` or
   `[ZH]`)? If so, what value does it take for the reference
   container (stock top 9.5 mm, clearance 14.5 mm → machine
   +5.000) and does it agree with the native post?
4. Units: does the inch file format positions to 4 decimal
   places and the mm file to 3 (the guide's convention), and do
   feeds follow the same split? Record the actual `VAR`
   formats — do not assume the convention holds.

A `.pp` whose Z convention cannot be determined from the file is
UNKNOWN in the Z row, and the gate fails.

### 1.8 Conditionals, string operations, and "anything else" — the open questions

The scope doc (§6.3) says to catalogue "variables, blocks,
conditionals, string operations, formatting". The published
Vectric guide read for this plan contains **no general
conditional construct**: no `IF`/`ELSE`/`ENDIF`, no loops, no
computed jumps, no expression language beyond the `VAR`
multiplier (§1.3.4). The only conditional-*like* mechanisms in
the guide are:

- `WO=C` — a variable is output only when its value changed
  (§1.3.3);
- `FIRST_*` blocks — a different block fires for the first move
  in a series (§1.5);
- `SPINDLE_SPEED_RANGE` — a value mapping (§1.2.6);
- `SUBSTITUTE` — character substitution (§1.2.7).

The evaluation must therefore treat "conditionals" as a
**check-item, not a presumed feature**, and record one of:

- **(a)** The Masso files contain no conditional construct beyond
  the four mechanisms above → the subset stays finite-state and
  §5 criterion 2 is satisfiable.
- **(b)** The files contain a conditional/loop/branching
  construct not in the published guide (a newer VCarve version,
  an Onefinity extension, or a construct the guide documents
  elsewhere) → quote it verbatim with line numbers, state its
  semantics as observed, and apply §5 criterion 2 to it
  directly. A loop, a backward jump, or a condition on anything
  other than "value changed" / "first in series" is strong
  evidence the subset is the full macro language in disguise.
- **(c)** The files contain string operations beyond `SUBSTITUTE`
  (concatenation, slicing, case changes, formatting of
  `[TOOLNAME]` etc.) → quote them, state what they operate on,
  and apply §5 criterion 3 (a string op on a VCarve-only
  variable in a control line fails the gate).

"Anything else a `.pp` can contain" is covered by the UNKNOWN
rule (§1 preamble): any line that fits no catalogue row is
recorded verbatim and fails criterion 1 until classified. The
evaluation does not get to wave an unfamiliar line through as
"probably a comment".

## 2. The decision — stated as a test

The evaluation's verdict is one of two outcomes (a third,
partial-coverage variant is defined below). The test is applied
criterion by criterion, in writing, with the catalogue evidence
cited per criterion. **All seven criteria must pass for BUILD.
Any one failure is NO-BUILD.** There is no partial credit and no
"build it anyway, the sim will catch it" — the sim is the second
defence (§6), not a substitute for the gate (§9, Q2 in the scope
doc).

### BUILD (V3.7b goes ahead) — iff ALL of:

1. **Complete coverage.** UNKNOWN = 0 in both files: every line
   is classified in §1, every `VAR` has a recorded definition or
   a documented default, every block has a stated trigger in
   terms of our move stream.
2. **Finite-state, bounded execution.** The covering subset has
   no loops, no recursion, no backward jumps, no computed
   control flow. Execution is a single linear pass over the
   moves: per move, at most one block fires per event class, each
   block emits a bounded number of lines (the maximum is counted
   from the files, §4). Total output lines ≤ (moves × max
   lines-per-move-block) + header + footer + tool changes ×
   toolchange-lines. State is bounded and named: last-emitted
   values for `WO=C` variables, first-in-series flags, the line
   counter, the current/previous tool. Nothing else persists
   across moves.
3. **Every variable suppliable.** Every variable used in a
   motion or control line has a source in §1.4 rows A–C with the
   mapping written down. Variables from row D appear only in
   comments, with the handling stated (omit / fixed placeholder).
   No variable is in row E. The Z conversion (§1.7) is
   determined and stated.
4. **Parser coverage.** Every G-code word the files can emit is
   within `ts/gcode_parse.ts` coverage (docs-v3/gcode.md §8:
   G0/G1/G2/G3 + X/Y/Z, I/J arcs incl. helical, modal, G90, G17,
   G20/G21, G94, G40, G54–G59, G80; M0/M1, M3/M5, T+M6, M9,
   M30; `(…)` and `;` comments). No canned cycles (G73/G81/G82/
   G83), no G41/G42, no G43/G49, no G4, no subprograms, no
   G28/G30/G53, no G92, no G68, no G95/G93 — unless the
   evaluation explicitly scopes a parser extension as a V3.7b
   prerequisite *and* the extension is itself bounded and
   listed. Output outside parser coverage can never be
   round-trip-verified, so it cannot ship.
5. **Deterministic.** Same job + same post file → byte-identical
   output. No `[DATE]`/`[TIME]` (or equivalent) in the output
   except, at most, inside a comment that the interpreter
   strips or fixes — and if stripped, the evaluation says so.
   No randomness, no environment dependence (no file paths from
   the operator's machine leaking into the output via
   `[TP_DIR]`/`[PATHNAME]` — row D, comment-only).
6. **No side effects.** No file/network access, no
   `TAPE_SPLITTING` (multi-file output), no `PRINT_DIRECT` /
   `DIRECT_OUTPUT`, no `POST_BASE` (another file's contents),
   no `ROTARY_WRAP`, no `INVERSE_TIME_MODE`, no jet blocks with
   command lines. The interpreter's only inputs are the post
   text + the moves + the job/machine profile; its only output
   is the G-code lines.
7. **Limits still enforced.** The `.pp` path reuses the native
   posts' limit enforcement (docs-v3/gcode.md §2:
   `post_limit_exceeded`, refused never clamped — feed,
   spindle, Z span vs travel, XY travel span vs bed, machine Z
   never below stock bottom or above clearance), or the
   evaluation states the equivalent check the V3.7b design must
   include and where it sits. A `.pp` that could emit an
   over-limit feed the native posts would refuse is a gate
   failure, not a V3.7b detail.

### NO-BUILD (native posts only, `.pp` a documented non-goal) — if ANY of:

- UNKNOWN > 0 after classification (criterion 1);
- a loop / recursion / jump / general conditional (§1.8 case b)
  is present and load-bearing (criterion 2);
- a motion-affecting variable has no source (criterion 3), or
  the Z convention is undeterminable (§1.7);
- the files can emit a word outside parser coverage that
  cannot be removed without changing the post's meaning
  (criterion 4) — e.g. a dwell the Masso needs, or G43 in the
  tool change;
- output is non-deterministic (criterion 5) or has side effects
  (criterion 6);
- the covering subset, once written down, is "everything the
  format can express" — i.e. covering these two files required
  a general expression evaluator, general string operations, or
  general control flow. That is the scope doc's "full macro
  language in disguise" test, applied to the subset itself: if
  the subset spec is as long and as general as the format spec,
  it is not a subset.

**On NO-BUILD**, V3.7 closes as "evaluated, not built": the
evaluation report is filed (see §4.5), `docs-v3/gcode.md` (or the
V3.10 docs pass) gains a short "`.pp` files are a documented
non-goal" note stating the reason in one paragraph with the
evaluation as the citation, and no interpreter code is written.
The native Masso posts remain the path. The V3.8 trade-off
(post_config.md §3) stands: the Preferences "Post processor"
field records a native post id, and a `.pp` name is not recorded
there — if V3.7b ever lands later, it needs its own selection /
record field; it must not reuse that one.

### Partial-coverage variant (recorded, not assumed)

If one file passes all seven criteria and the other fails, or a
file passes except for one named block/construct, the evaluation
may record a **partial** verdict: "interpreter covers <file /
construct set>, refuses <named remainder> with a named error".
Partial is allowed only if (a) the covered subset still passes
all seven criteria on its own, (b) the refusal is per-file or
per-block and loud (a named error, exit 1, no file written —
never a silent skip of a block), and (c) the uncovered remainder
is named in the verdict, not left as a TODO. Partial does not
soften any criterion; it narrows the scope the criteria apply
to.

## 3. Sandbox requirements the interpreter would have to meet

These are requirements on V3.7b, stated now so the evaluation
can check they are *statable* for the covering subset — if a
requirement below cannot be stated for the subset, that is
evidence for NO-BUILD under §2. The numbers in brackets are
**proposed** bounds: the evaluation confirms or revises them by
measuring the native posts on the same jobs (§4.3) before V3.7b
starts, and V3.7b asserts them in tests.

| # | Requirement | How it would be verified (in V3.7b) |
|---|---|---|
| 3.1 | **No file access.** The interpreter reads exactly two inputs — the post text and the moves (+ job/machine profile values passed in as data) — and writes exactly one output, the G-code lines. It opens no files, lists no directories, reads no environment. | Code inspection: the interpreter module imports no `fs`, `path`, `net`, `child_process`, or equivalent; its function signature takes strings/objects and returns lines. A test passes a post whose text mentions a file path and asserts the path is never read (output contains no file contents). |
| 3.2 | **No network access.** No sockets, no fetch, no DNS. | Same inspection as 3.1. The interpreter runs in-process in Bun with no network capability in its module graph. |
| 3.3 | **Bounded time.** Execution terminates. Step budget: at most [10,000,000] block-line executions per post run, and a wall-clock cap of [120 s] for the largest reference job (Kookabus, 75,922 moves). The step cap trips first by construction (it is counted, not timed). | Post the Kookabus job through the interpreter and assert completion + step count; assert the step count is ≤ moves × (max lines in any block) + constant, i.e. the bound is structural, not a timeout prayer. A mutation test feeds a post with a self-referential construct (if the format admits one) and asserts refusal/termination, never a hang. The wall-clock number is confirmed against the native masso-mm post's measured time on the same job (§4.3) — the final cap must be ≥10× the native time, so a slow interpreter is a bug, not a timeout. |
| 3.4 | **Bounded output.** Output lines ≤ (moves × max lines in any move block) + header + footer + (tool changes × toolchange lines), and bytes ≤ [50 MB]. Exceeding the bound is a refusal, not a truncation. | Post all five reference jobs; assert line/byte counts against the bound computed from the catalogue. A mutation test with a block that emits an unbounded number of lines (if constructible) asserts refusal. |
| 3.5 | **Bounded memory.** Interpreter state is the named state in §2 criterion 2 (last-emitted values, first-flags, line counter, current/previous tool) plus one output buffer that is streamed or capped by 3.4. No per-move accumulation beyond the output itself. | Post Kookabus; assert peak memory within [512 MB] (measured, e.g. via Bun's process memory reporting in the test driver). The delta-log lesson (§5.5 of the scope doc) applies: state proportional to moves is output, not hidden state. |
| 3.6 | **Refusal, never silent wrong output.** Any construct outside the covering subset, any variable with no value, any output word outside parser coverage, any limit breach → a named error, exit 1, no file written, no `gcode` entry published. | Mutation battery (§4.4): for each catalogue row, a post with that construct corrupted/removed must refuse. For each variable, a run with its value source deleted must refuse. The CLI behaviour mirrors the native posts (`post_limit_exceeded`, `gcode_unverified`, exit 1 — docs-v3/gcode.md §2/§7, post_config.md §4). |
| 3.7 | **Determinism.** Same inputs → byte-identical output (§2 criterion 5). | Re-post each reference job; assert byte-identical sha256. The native posts already meet this (docs-v3/gcode.md §7); the `.pp` path must meet the same bar. |
| 3.8 | **Same limits as native posts.** Feed/spindle/Z-travel/bed-span limits refused, never clamped (§2 criterion 7). | The `.pp` post is implemented as a `PostDef` driven by the interpreter, so `ts/posts/common.ts` `postJob` enforces limits unchanged — or the evaluation states the equivalent. Verified live with over-limit feed and spindle cases, as V3.8 did for the native posts (post_config.md §5). |
| 3.9 | **No ambient authority.** The interpreter must not inherit the operator's VCarve install, ToolDB, or machine state. Every value it uses comes through the stated inputs (§1.4). | Inspection + the row-D rule: a post that references ToolDB notes (`[TOOL_NOTES]`) or file paths must not cause any read outside the inputs. A test posts with a `TOOL_NOTES` variable present and asserts the output contains no ToolDB content. |

## 4. The evaluation runbook (execute in order when the files land)

### 4.1 Intake

1. Receive the two files (§7). Record: filename as received,
   byte size, sha256, `POST_NAME`, `UNITS`, `FILE_EXTENSION`,
   line count, VCarve version (from Brandon), stock vs
   customised (History block + Brandon's word).
2. Store them in the evaluation scratch dir (§7) — **not** in
   the repo (see §7, licensing note). The evaluation report
   cites sha256 + line numbers, never the file contents.
3. Confirm the two files are the ones Brandon actually posts
   with (not an older copy): `POST_NAME` must read as the
   Onefinity Masso inch/mm posts, versions V6 / V3.

### 4.2 Catalogue pass (the bulk of the evaluation)

4. Classify every line of each file into §1 (one row per line;
   UNKNOWN recorded verbatim with line numbers). Produce the
   per-file, per-category counts and the distinct-value tables
   (§1.3.1, §1.5).
5. Build the §1.4 value-source table: every variable used,
   source A–E, mapping written down (or "no mapping" — a
   finding).
6. Do the §1.7 Z/units check and write the Z-convention
   paragraph with the worked container numbers.
7. Settle §1.8: conditional/string-op verdict (a), (b), or (c),
   with verbatim quotes for (b)/(c).
8. Write the covering-subset spec: the list of constructs the
   subset includes (by §1 row), the list it excludes, and the
   refusal for each excluded construct. If the subset spec is
   as general as the format spec, say so — that is the
   "disguise" test (§2).

### 4.3 Measurement (bounds the sandbox numbers in §3)

9. Measure the native posts on the five reference jobs
   (real_container, machined, eight_parts, kookabus, and the
   8-layer reference container — the V3.6 acceptance set,
   docs-v3/gcode.md §10): post time per job through
   `masso-mm` and `masso-inch`, output lines/bytes per job.
   These are the baselines §3's proposed caps are confirmed
   against (final wall-clock cap ≥10× native time on Kookabus;
   final output bound from the catalogue's max-lines-per-block,
   checked against the native line counts).
10. Predict the `.pp` output bound from the catalogue
    (moves × max lines per move block + header/footer +
    tool changes) for each reference job and record the
    prediction in the evaluation report — V3.7b measures
    against it.

### 4.4 Calibration (proves the safety net works for `.pp` output)

11. Once V3.7b exists (not in the evaluation): run the
    deliberate-breakage battery from docs-v3/gcode.md §7
    against the `.pp` post on the reference container — every
    X +0.06 mm, every Z −0.2 mm, file truncated to 70% — and
    require all three to fail round-trip verification
    (band + cluster, `ROUND_TRIP_MAX_CLUSTER` = 3). This
    proves the band/cluster criterion still discriminates for
    `.pp` output, whose rounding is the inch/mm formatting in
    the files, not the native posts'.
12. Cross-check vs native: post each reference job through
    both the `.pp` post and the native Masso post of the same
    units; both must round-trip-verify to the same stock.
    Motion lines are compared semantically (parse both files
    with `ts/gcode_parse.ts` and compare the move streams),
    not textually — header/footer/formatting differences are
    reviewed line by line and each difference is either
    explained or filed.

### 4.5 Verdict and handoff

13. Apply §2 criterion by criterion, citing the catalogue
    evidence per criterion. Verdict: BUILD, NO-BUILD, or
    PARTIAL (with the covered/refused sets named).
14. Write the evaluation report as `docs-v3/pp_evaluation_report.md`
    (the findings document — this plan stays the plan) and
    update the status line of this file. If BUILD: the report's
    covering-subset spec + refusal list is the V3.7b input, and
    V3.7b's first task is the sandbox tests in §3. If
    NO-BUILD: the report states the reason in one paragraph,
    and the V3.10 docs pass adds the non-goal note (§2).
15. Log the run in `hidden_files/v37a_run.log` (the evaluation
    run's own log — this prep wave's log is
    `hidden_files/v37a_prep_run.log`).

## 5. Reference jobs and existing machinery the evaluation uses

- **Reference jobs** (V3.6 acceptance set, docs-v3/gcode.md
  §10): `real_container` (10 ops / 158 moves), `machined`
  (19 / 419), `eight_parts` (66 / 1,154), `kookabus` (335 /
  75,922 moves), and the 8-layer reference container
  (`20261124-160834-real-container`, 14 ops / 220 moves,
  pitch 0.05, stock top 9.5 mm). Kookabus is the bound-setter
  (largest move count); the container is the calibration job.
- **Native posts**: `ts/posts/` — `common.ts` (`postJob`,
  `PostHooks`, `MachineLimits`, limit enforcement),
  `masso.ts` (`MASSO_MM`/`MASSO_INCH`), `grbl.ts`,
  `template.ts`, registry `ts/posts/index.ts`. The `.pp`
  interpreter, if built, is a `PostDef` whose hooks are
  driven by the interpreter, so limits and the driver stay
  shared — the evaluation should confirm that integration
  shape is viable for the covering subset (if the subset
  needs a hook the native model has no analogue for, that is
  a finding for §2 criterion 7).
- **Parser**: `ts/gcode_parse.ts` — coverage in docs-v3/gcode.md
  §8. The evaluation's criterion 4 is a set-intersection
  check between "words the files can emit" and this list.
- **Round-trip**: `ts/gcode_verify.ts` — `roundTripVerify`,
  band + cluster, `ROUND_TRIP_MAX_CLUSTER = 3`,
  `ROUND_TRIP_EPS_MM = 0.05`; recorded stock/pitch via
  `recordedSimStock` / `recordedSimPitchMm`.
- **CLI**: `mldxf gcode <job-dir> [--post <post-id>]`
  (V3.6) and `mldxf gcode --verify` (V3.8, `ts/gcode.ts`
  `--verify` mode — read-only, re-verifies the recorded
  file: entry exists, file exists, sha256 matches, parse +
  round-trip; named refusals `gcode_not_posted` /
  `gcode_file_missing` / `gcode_sha_mismatch` /
  `gcode_unverified`). The evaluation does **not** decide the
  V3.7b CLI shape (e.g. how a `.pp` file is named as a post);
  it records the requirement that the `.pp` path goes through
  this same driver so the same parse + round-trip + `job.json`
  `gcode` entry + `verified` stamp flow applies, and the same
  `--verify` re-checks it afterwards.
- **Job model**: `docs-v3/job_model_v3.md` §6.1 (`gcode`
  entries: `post_id`, `file`, `sha256`, `verified`,
  `generated_at`; one entry per post run). A `.pp` post run
  is one entry with its own `post_id` — the evaluation notes
  the `post_id` naming question for V3.7b (it must not
  collide with the native ids in `ts/posts/index.ts`).

## 6. The round-trip verification hook — how a `.pp` post's output is checked

This is the second defence (the gate is the first). It reuses
the existing V3.6/V3.8 machinery unchanged — no new verifier is
designed here.

1. **Post**: the `.pp` interpreter (V3.7b) runs against the
   job's `toolpaths` moves and writes
   `gcode/<job-id>-<post-id>.nc`, exactly as `ts/gcode.ts`
   does for native posts.
2. **Parse back**: `ts/gcode_parse.ts` parses the file into
   moves in job coordinates (machine Z + stockTop). Anything
   the parser refuses (`gcode_parse_unsupported` — canned
   cycles, G43, G4, subprograms, …) fails the run: the file is
   published as `verified: false` and the CLI exits 1 with
   `gcode_unverified` (docs-v3/gcode.md §7, "Unverified
   handling"). **This is the safe direction**: unparseable
   output can never be presented as ready to run — but it also
   means a `.pp` that routinely emits parser-refused words can
   never verify, which is why §2 criterion 4 exists.
3. **Re-simulate**: `roundTripVerify` re-simulates the parsed
   moves through the V3.4 dexel engine on the *recorded* stock
   and pitch (`sim.stock` / `sim.pitch_mm` when present) and
   compares against the toolpath sim with the band + cluster
   criterion (band: a column counts only if outside the 3×3
   neighbourhood's height range ± tolerance in the other grid,
   both directions; cluster: largest 4-connected cluster of
   surviving mismatches ≤ 3). Tolerance is pitch + 0.05 mm.
   The criterion is calibrated for inch rounding (784 raw flips
   → 28 after the band → max cluster 1 on the reference
   container, verified) and discriminates a 0.06 mm path shift
   (max cluster 22 — fails) and a −0.2 mm Z shift (fails).
   The `.pp` files' own formatting (decimal places per
   §1.3.5) determines their rounding; §4.4 re-runs the
   calibration against `.pp` output to prove the criterion
   still discriminates there.
4. **Stamp**: the `gcode` entry carries `verified` plus the
   round-trip numbers (`rawMismatched`, `mismatched`,
   `clusters`, `maxCluster`, `maxDiffMm`) so the stamp is
   auditable, never just a boolean. Unverified G-code is
   refused by the CLI (exit 1) and marked unverified in the
   UI — downloadable for inspection, never presented as ready
   to run (post_config.md §4).
5. **Re-verify later**: `mldxf gcode --verify` re-checks the
   recorded file as it sits on disk (sha first, then parse +
   round-trip), so a file corrupted — or a toolpath changed —
   after posting is caught (post_config.md §4). The `.pp` path
   gets this for free by going through the same driver (§5).
6. **What the round-trip cannot catch** (recorded honestly):
   a mis-translation that produces *valid, parseable* G-code
   cutting the *wrong* geometry in a way the dexel sim cannot
   distinguish at the recorded pitch (e.g. a sub-pitch shift
   on a coarse-pitch job, or a wrong-but-plausible feed that
   changes no stock). That is why the gate (§2) exists and why
   the operator's dry run (docs-v3/dry_run_foreman.md) remains
   part of acceptance — the sim is a check, not a proof. The
   evaluation must state this limit in its report, not bury it.

## 7. What Brandon needs to send

**The blocker.** V3.7a cannot start without these. The exact ask:

1. **The two `.pp` files, as files** (plain text, small):
   - **Onefinity Masso (inch) Latest V6** — the inch file.
   - **Onefinity Masso (mm) Latest V3** — the mm file.
   - Send the files as they are in his VCarve install (File >
     Open Application Data Folder > PostP, or his `My_PostP`
     folder). **Do not rename them** — the evaluation records
     the filenames as received, and `POST_NAME` inside each
     file is cross-checked against the name he gave.
2. **VCarve version** — which VCarve Pro version he runs (the
   `.pp` format gains constructs across versions; the
   evaluation needs to know which guide version applies, and
   whether a construct in the files postdates the published
   guide — see §1.8 case (b)).
3. **Stock or customised?** — whether these are the stock
   Onefinity files or ones he (or someone) has edited. The
   History comment block in each file should say; his word
   confirms it. An edited file is evaluated as-is — the
   evaluation catalogues what is there, it does not restore
   stock.
4. **Where to put them** (for the coordinator / evaluation
   worker, not for Brandon to place): a scratch dir **outside
   the repo**, e.g. `~/workspace/pp-eval/` — one file per
   version, as received. **Do not commit the `.pp` files to
   the repo**: they are Vectric/Onefinity-supplied files from
   his VCarve install, and this repo is public; the evaluation
   works from the scratch copies and cites sha256 + line
   numbers, never the file contents. If a later wave needs a
   checked-in fixture, that is a separate decision with the
   licensing question answered first.
5. **Optional, helps but does not block**: a sample `.nc` file
   posted from VCarve with each `.pp` (any small job — the
   container profile is ideal, any job will do). This is the
   only way to check the interpreter's formatting against
   VCarve's own output (modal suppression §1.3.3, first-block
   behaviour §1.5) rather than against the guide's prose.
   Without it, those behaviours are assumptions flagged in
   the report and tested in V3.7b against the round-trip
   only. Not required for the evaluation to start.
6. **Nothing else is needed.** No ToolDB export, no machine
   config, no VCarve install access. Feeds/speeds come from
   the job's toolpaths; machine limits come from the existing
   native Masso posts (docs-v3/gcode.md §2).

## 8. Status

- **V3.7a evaluation: BLOCKED** — awaiting the two files in §7.
- **V3.7b interpreter: NOT DESIGNED, NOT BUILT** — gated on
  the evaluation (§2). No interpreter code exists; no
  interpreter design exists beyond the requirements in §3 and
  the integration shape noted in §5 (a `PostDef` driven by
  the interpreter, reusing `postJob` limits).
- **This document (V3.7a prep, 2026-11-25):** the evaluation
  plan + the grounded catalogue categories + the decision test
  + the sandbox requirements + the round-trip hook + the
  precise ask for Brandon. No findings. Run log:
  `hidden_files/v37a_prep_run.log`.
- **Sources:** V3_SCOPE.md §6.3 (gate), §11.3 (the files),
  §6.4 (safety bar), §5.6/§6.4 (round-trip); V3_BACKLOG.md
  "TRIAGED V3.7"; docs-v3/gcode.md (§1–§8, esp. §7
  calibration + §8 parser coverage); docs-v3/post_config.md
  (§3 trade-off, §4 `--verify`); Vectric *Post Processor
  Editing* guide, V11.5 Aspire ENU (docs.vectric.com, read
  2026-11-25) for the `.pp` format categories in §1.
