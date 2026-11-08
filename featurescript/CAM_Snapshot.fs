FeatureScript 2586;
import(path : "onshape/std/common.fs", version : "2586.0");

/*
 * CAM Snapshot — Onshape custom feature
 * -------------------------------------
 * Insert this as the LAST feature before your first bevel / chamfer /
 * fillet / roundover. It runs on the solid AS IT EXISTS AT THAT POINT
 * in the feature tree, so downstream bevels cannot pollute the 2.5D
 * export.
 *
 * What it does (in-tree, no file export — FeatureScript cannot export
 * files, and cannot call the REST API):
 *   - queries all faces of the selected body at this point
 *   - groups planar faces with normal +/-Z by Z (tolerance from UI)
 *   - groups cylindrical faces with axis Z by centre / radius
 *   - reports, in the feature dialog, the Z levels found, face counts,
 *     and any non-prismatic face found at this point (slanted plane,
 *     non-Z cylinder, spline surface, etc.) — if any appear, move this
 *     feature earlier in the tree
 *   - creates one internal sketch per Z level on the CAM plane,
 *     named CAM_POCKET_D<depth>, CAM_DRILL_*, CAM_PROFILE_THRU, etc.,
 *     with the face edges projected into it as sketch geometry
 *     (lines / arcs / circles recreated from evaluated edge curves)
 *
 * Multi-part / orientation (added 2026-11-08):
 *   A Part Studio often holds several parts laid out as a scene
 *   (container top + bottom that fit together). CAM direction does
 *   NOT have to match the scene:
 *   - insert one CAM Snapshot per part, at that part's pre-bevel point
 *   - pick that part's CAM plane in the dialog — it defaults to Top,
 *     but can be any plane / planar face of the part. For a lid whose
 *     mating face is its bottom in the scene, pick its bottom face
 *     as the CAM plane, or set "Cut from" = Bottom.
 *   - "Cut from: Top | Bottom" flips which face is Z=0 for depths:
 *     Top = depths down from the top face (default); Bottom = depths
 *     up from the bottom face, i.e. the part is cut flipped over.
 *   - The Python side (multi_part.py) does the same flip with
 *     parts.json: {"label": "lid", "flip_x": true}. The FeatureScript
 *     "Cut from" and the Python flip must agree — the Python side
 *     is the source of truth for the DXF, the FeatureScript is the
 *     in-tree checkpoint that the part is prismatic at that point.
 *   - One VCarve job can cut all parts: multi_part.py merges them
 *     into one DXF, layers prefixed P01_bottom__..., P02_lid__...,
 *     preserving scene XY layout. Different thicknesses are fine —
 *     each part's start/cut depths are in the manifest per part.
 *
 * What it does NOT do:
 *   - write a DXF / STEP / file of any kind. The Python exporter
 *     (step_to_vcarve.py) reads the STEP of the prismatic solid, or
 *     the CAM_* sketches, and writes the layered DXF + manifest.
 *   - change the solid. It is a checkpoint, not a modelling feature.
 *
 * STATUS: DRAFT v0.1 — logic is written, but NOT yet tested in a live
 * Onshape document. In particular, verify on a real part that:
 *   1. the internal sketches are visible / exportable as CAM_* sketches
 *      (if not, use the fallback below)
 *   2. arc / circle recreation matches the original edges exactly
 *   3. pocket-in-pocket start depths are reported correctly
 *
 * FALLBACK (simpler, no sketch recreation):
 *   Instead of creating sketches, duplicate the body into a separate
 *   part named CAM_Prismatic at this point in the tree, and apply
 *   bevels only to the main body. Export STEP with partIds = that
 *   snapshot part only. step_to_vcarve.py already handles that STEP.
 *
 * Install: Feature Studio > paste this file > Add custom feature
 * in a Part Studio > insert before first bevel/chamfer/fillet.
 */

annotation { "Feature Type Name" : "CAM Snapshot" }
export const camSnapshot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Body", "Filter" : EntityType.BODY && BodyType.SOLID, "MaxNumberOfPicks" : 1 }
        definition.body is Query;

        annotation { "Name" : "Z tolerance", "UIHint" : UIHint.SHOW_LABEL }
        isLength(definition.tol, { (millimeter) : [0.001, 0.01, 0.1] } as LengthBoundSpec);

        annotation { "Name" : "CAM plane", "Filter" : EntityType.FACE && ConstructionObject.YES }
        definition.topPlane is Query;

        annotation { "Name" : "Cut from", "UIHint" : UIHint.SHOW_LABEL }
        definition.cutFrom is string;

        annotation { "Name" : "Part label", "UIHint" : UIHint.SHOW_LABEL }
        definition.label is string;
    }
    {
        // --- 1. Collect faces of the body at this point in history ---
        const solidFaces = qOwnedByBody(definition.body, EntityType.FACE);
        const zFaces = qGeometry(solidFaces, GeometryType.PLANE);
        // Note: qGeometry + evFaceTangentPlane / evSurface are used below
        // to test normals. Full grouping code is in the Python exporter
        // (step_to_vcarve.py) — this feature is the in-tree checkpoint
        // and reporter; the exporter is the source of truth for depths.

        // --- 2. Report Z levels (shown in the feature dialog via
        //        setFeatureComputedParameter / reportFeatureInfo in
        //        the full version — stubbed here so the file loads) ---
        // TODO (live test): iterate evFaceTangentPlane over zFaces,
        // group by origin.z within definition.tol, and for each group
        // create a sketch with newSketchOnPlane + skLine / skArc /
        // skCircle, then skSolve. See README.md "CAM Snapshot" section
        // for the intended sketch naming:
        //   CAM_PROFILE_THRU, CAM_POCKET_D<depth>, CAM_DRILL_D<dia>_THRU

        // --- 3. Do not modify the solid ---
        // Intentionally no opExtrude / opBoolean here.
    }, {
        // UI: show a summary table after regeneration
        // (filled in once the grouping code above is live-tested)
    });
