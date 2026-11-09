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
 *   - creates one internal sketch per Z level on a plane at that Z,
 *     with the face edges recreated as sketch geometry (lines / arcs /
 *     circles from the evaluated edge curves), named in the feature's
 *     computed parameters as CAM_PROFILE_THRU / CAM_POCKET_D<depth> /
 *     CAM_DRILL_D<dia>_THRU etc.
 *   - reports, via computed parameters, the Z levels found, face
 *     counts, and any non-prismatic face found at this point (slanted
 *     plane, non-Z cylinder, spline surface, etc.) — if any appear,
 *     move this feature earlier in the tree
 *   - does NOT change the solid. It is a checkpoint, not a modelling
 *     feature.
 *
 * Multi-part / orientation:
 *   A Part Studio often holds several parts laid out as a scene
 *   (container top + bottom that fit together). CAM direction does
 *   NOT have to match the scene:
 *   - insert one CAM Snapshot per part, at that part's pre-bevel point
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
 *     (step_to_vcarve.py) reads the STEP of the prismatic solid and
 *     writes the layered DXF + manifest.
 *   - change the solid.
 *
 * STATUS: v0.2 — grouping + sketch creation are now written (v0.1
 * was a stub), but NOT yet tested in a live Onshape document. Verify
 * in a real Part Studio that:
 *   1. the internal sketches appear under the feature and are
 *      exportable as CAM_* sketches (if not, use the fallback below)
 *   2. arc / circle recreation matches the original edges exactly
 *   3. pocket-in-pocket start depths are reported correctly
 *   4. the API calls marked UNVERIFIED below behave as assumed —
 *      evSurface cylinder fields, evCurveDefinition ARC/CIRCLE
 *      fields, and setFeatureComputedParameter. If any of them is
 *      wrong, the feature will error at regeneration with the call
 *      name in the message; fix that call, the rest stands.
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

        annotation { "Name" : "Cut from (Top or Bottom)", "UIHint" : UIHint.SHOW_LABEL }
        definition.cutFrom is string;

        annotation { "Name" : "Part label", "UIHint" : UIHint.SHOW_LABEL }
        definition.label is string;
    }
    {
        const tol = definition.tol;
        const cutFromBottom = definition.cutFrom == "Bottom";

        // --- 1. Collect faces of the body at this point in history ---
        const faces = evaluateQuery(context, qOwnedByBody(definition.body, EntityType.FACE));

        // Z groups: array of { z, faces } for planar faces with normal +/-Z
        var zGroups = [];
        // Z cylinders: array of { cx, cy, radius, zMin, zMax, faces }
        var zCylinders = [];
        var nonPrismatic = []; // strings describing faces that are not 2.5D
        var zMin = 1e9 * millimeter;
        var zMax = -1e9 * millimeter;

        for (var i = 0; i < size(faces); i += 1)
        {
            const face = faces[i];
            const surf = evSurface(context, { "face" : face });
            if (surf.surfaceType == SurfaceType.PLANE)
            {
                const plane = evFaceTangentPlane(context, { "face" : face });
                const nz = plane.normal.z;
                if (abs(nz) > 0.999)
                {
                    const z = plane.origin.z;
                    if (z < zMin) zMin = z;
                    if (z > zMax) zMax = z;
                    var found = false;
                    for (var g = 0; g < size(zGroups); g += 1)
                    {
                        if (abs(zGroups[g].z - z) <= tol)
                        {
                            append(zGroups[g].faces, face);
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                    {
                        append(zGroups, { "z" : z, "faces" : [face] });
                    }
                }
                else
                {
                    // A vertical (side) wall is expected and fine — it is
                    // not a Z level. Only a slanted plane is a problem.
                    const nx = abs(plane.normal.x);
                    const ny = abs(plane.normal.y);
                    if (nx < 0.999 && ny < 0.999)
                    {
                        append(nonPrismatic, "slanted plane, normal " + toString(plane.normal));
                    }
                }
            }
            else if (surf.surfaceType == SurfaceType.CYLINDER)
            {
                // UNVERIFIED: evSurface cylinder fields — assumed here
                // to be surf.axis (a Line: origin + direction) and
                // surf.radius. Confirm in the live test; if the field
                // names differ, this branch errors at regeneration.
                const axisDir = surf.axis.direction;
                if (abs(axisDir.z) > 0.999)
                {
                    const cx = surf.axis.origin.x;
                    const cy = surf.axis.origin.y;
                    const r = surf.radius;
                    var foundCyl = false;
                    for (var c = 0; c < size(zCylinders); c += 1)
                    {
                        if (abs(zCylinders[c].cx - cx) <= tol
                            && abs(zCylinders[c].cy - cy) <= tol
                            && abs(zCylinders[c].radius - r) <= tol)
                        {
                            append(zCylinders[c].faces, face);
                            foundCyl = true;
                            break;
                        }
                    }
                    if (!foundCyl)
                    {
                        append(zCylinders, { "cx" : cx, "cy" : cy, "radius" : r, "faces" : [face] });
                    }
                }
                else
                {
                    append(nonPrismatic, "non-Z cylinder, radius " + toString(surf.radius) + " mm");
                }
            }
            else
            {
                append(nonPrismatic, "non-prismatic surface: " + toString(surf.surfaceType));
            }
        }

        // Sort Z groups top-down so sketch order matches cut order.
        // (Insertion sort — groups are few, dozens at most.)
        for (var a = 1; a < size(zGroups); a += 1)
        {
            const tmp = zGroups[a];
            var b = a - 1;
            while (b >= 0 && zGroups[b].z < tmp.z)
            {
                zGroups[b + 1] = zGroups[b];
                b -= 1;
            }
            zGroups[b + 1] = tmp;
        }

        // --- 2. One sketch per Z level, edges recreated as geometry ---
        var sketchSummary = [];
        for (var g = 0; g < size(zGroups); g += 1)
        {
            const group = zGroups[g];
            const z = group.z;
            const depth = cutFromBottom ? (z - zMin) : (zMax - z);
            const sketchId = id + ("sketchZ" + toString(g));
            const sketchPlane = plane(vector(0, 0, z), vector(0, 0, 1));
            const sketch = newSketchOnPlane(context, sketchId, { "sketchPlane" : sketchPlane });
            var entityCount = 0;
            var skippedEdges = 0;
            for (var f = 0; f < size(group.faces); f += 1)
            {
                const edges = evaluateQuery(context, qAdjacent(group.faces[f], AdjacencyType.EDGE));
                for (var e = 0; e < size(edges); e += 1)
                {
                    const curve = evCurveDefinition(context, { "edge" : edges[e] });
                    // UNVERIFIED: evCurveDefinition field names for ARC
                    // and CIRCLE — assumed startPoint / midPoint /
                    // endPoint for ARC and center / radius for CIRCLE,
                    // matching the LINE fields startPoint / endPoint.
                    if (curve.curveType == CurveType.LINE)
                    {
                        skLineSegment(sketch, sketchId + ("line" + toString(entityCount)),
                            { "start" : curve.startPoint, "end" : curve.endPoint });
                        entityCount += 1;
                    }
                    else if (curve.curveType == CurveType.ARC)
                    {
                        skArc(sketch, sketchId + ("arc" + toString(entityCount)),
                            { "start" : curve.startPoint, "mid" : curve.midPoint, "end" : curve.endPoint });
                        entityCount += 1;
                    }
                    else if (curve.curveType == CurveType.CIRCLE)
                    {
                        skCircle(sketch, sketchId + ("circle" + toString(entityCount)),
                            { "center" : curve.center, "radius" : curve.radius });
                        entityCount += 1;
                    }
                    else
                    {
                        // Spline / other edge: cannot be recreated as a
                        // sketch primitive — skip it and count it, so
                        // the summary shows the sketch is incomplete
                        // instead of silently wrong.
                        skippedEdges += 1;
                    }
                }
            }
            skSolve(sketch);
            var name = "CAM_Z" + toString(round(z / millimeter * 100) / 100);
            if (abs(depth) < tol)
            {
                name = "CAM_PROFILE_THRU";
            }
            else
            {
                name = "CAM_POCKET_D" + toString(round(depth / millimeter * 100) / 100);
            }
            append(sketchSummary, name + " (Z " + toString(round(z / millimeter * 100) / 100)
                + " mm, " + toString(entityCount) + " entities"
                + (skippedEdges > 0 ? (", " + toString(skippedEdges) + " edges skipped") : "") + ")");
        }

        // --- 3. Report (computed parameters shown in the dialog) ---
        // UNVERIFIED: setFeatureComputedParameter signature — assumed
        // (context, id, { "name" : ..., "value" : ... }).
        setFeatureComputedParameter(context, id, {
                "name" : "Z levels (" + toString(size(zGroups)) + ")",
                "value" : sketchSummary
            });
        setFeatureComputedParameter(context, id, {
                "name" : "Z cylinders (" + toString(size(zCylinders)) + ")",
                "value" : zCylinders
            });
        setFeatureComputedParameter(context, id, {
                "name" : "Non-prismatic faces (" + toString(size(nonPrismatic)) + ")",
                "value" : nonPrismatic
            });
        // --- 4. Do not modify the solid ---
        // Intentionally no opExtrude / opBoolean here.
    }, {
        // UI: the computed parameters above are shown after regeneration.
    });
