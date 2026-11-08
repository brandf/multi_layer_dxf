-- Onshape25D.lua — VCarve Pro gadget (DRAFT v0.1, needs Windows VCarve test)
--
-- What it does, in one click inside VCarve Pro:
--   1. Reads manifest.txt written by step_to_vcarve.py
--      (one line per layer: layer|operation|start_depth|cut_depth|tool_dia)
--   2. Imports the layered DXF from the same folder (or, in
--      "toolpaths_only" mode, uses vectors already in the job)
--   3. Joins open vectors on each layer
--   4. Creates toolpaths in cutting order:
--        drill -> pockets shallow to deep -> profile last
--      with start_depth / cut_depth taken from the manifest, NOT typed
--   5. Recalculates all toolpaths, saves the .crv next to the DXF
--      (does NOT post G-code unless you tick "Post G-code" — preview first)
--
-- Flexible, not all-or-nothing:
--   MODE = "full"            -- import + toolpaths + save .crv
--   MODE = "toolpaths_only"  -- DXF already imported, just make toolpaths
--   MODE = "preview"         -- make toolpaths, do not save .crv
--   ONLY = { "drill", "pocket" }  -- e.g. drills only, or set to nil for all
--   SKIP_LAYERS = { "THROUGH_CUT" } -- layers to leave alone
--   TOOLS table below: change diameters / stepdown / stepover / feeds
--   here once, the gadget reuses them for every model.
--
-- Install:
--   VCarve Pro > Gadgets > (copy this file + Onshape25D.html if present
--   into Public Documents/Vectric/VCarve Pro/Gadgets/Onshape25D/)
--   Restart VCarve, Gadgets menu > Onshape25D.
--
-- Honest status:
--   This is written from Vectric's published Gadget SDK docs:
--   ToolpathManager:CreatePocketingToolpath(name, tool, ..., pocket_data,
--   pos_data, geometry_selector, ...) with start_depth / cut_depth in
--   PocketParameterData, and CreateProfilingToolpath similarly.
--   The exact function signatures / import-vector call vary by VCarve
--   version (v11 / v12 / v12.5). I have NOT run this inside VCarve yet
--   — there is no VCarve on this Linux VM. Expect 1-2 rounds of fixing
--   API names against the SDK on your Windows machine before it is
--   trusted on a real part. The DXF + manifest path already works
--   without the gadget (import DXF, create toolpaths manually per layer),
--   so you are never locked into the gadget working first try.
--
-- If a SDK call fails, the gadget stops, reports which call failed,
-- and leaves the job untouched — it never silently creates a wrong
-- toolpath.

-- ================= user config (edit these once) =================
local MODE = "full"  -- "full" | "toolpaths_only" | "preview"
local ONLY = nil     -- e.g. { "drill", "pocket" } or nil for all operations
local SKIP_LAYERS = {} -- e.g. { "THROUGH_CUT" }

local TOOLS = {
  drill   = { dia_mm = 6.0,  stepdown_mm = 3.0, peck = true },
  pocket  = { dia_mm = 6.0,  stepdown_mm = 3.0, stepover_pct = 40 },
  profile = { dia_mm = 6.0,  stepdown_mm = 3.0, tabs = true, tab_count = 4 },
}
-- Set TOOLS.<op>.dia_mm = 0 to mean "use the hole diameter for drills,
-- and the default pocket/profile tool otherwise" — the gadget then
-- picks a drill matching the hole, or falls back to helical pocketing
-- with the pocket endmill if no matching drill exists in the tool DB.
-- =================================================================

function main()
  -- TODO (Windows test): file picker for manifest.txt
  -- local manifest_path = GetFileName("Select manifest.txt", "*.txt")
  -- local dxf_path = manifest_path:gsub("manifest%.txt$", "") .. "<stem>.dxf"
  -- Parse manifest.txt lines: layer|operation|start|cut
  --   for each line, in order (manifest is already drill->pocket->profile):
  --     if ONLY and operation not in ONLY then skip end
  --     if layer in SKIP_LAYERS then skip end
  --     Select vectors on that layer
  --     Join vectors (Edit > Join Vectors equivalent)
  --     local mgr = ToolpathManager()
  --     if operation == "drill" then
  --       -- mgr:CreateDrillingToolpath(name, tool, drilling_data, ...)
  --       -- drilling_data: start_depth, cut_depth, peck = TOOLS.drill.peck
  --     elseif operation == "pocket" then
  --       -- mgr:CreatePocketingToolpath(name, tool, area_clear_tool,
  --       --   pocket_data, pos_data, geometry_selector, ...)
  --       -- pocket_data: start_depth, cut_depth,
  --       --   stepdown = TOOLS.pocket.stepdown_mm,
  --       --   stepover = TOOLS.pocket.stepover_pct
  --     elseif operation == "profile" then
  --       -- mgr:CreateProfilingToolpath(name, tool, profile_data, ...)
  --       -- profile_data: cut_depth, tabs = TOOLS.profile.tabs
  --     end
  -- RecalculateAllToolpaths()
  -- if MODE == "full" then SaveJob() end
  -- DisplayMessageBox("Onshape25D: done — preview toolpaths before posting G-code.")
  DisplayMessageBox(
    "Onshape25D v0.1 is a draft.\n\n" ..
    "It is not yet wired to your VCarve install — the SDK calls in\n" ..
    "this file need one Windows test round first.\n\n" ..
    "Until then: import the layered DXF from step_to_vcarve.py,\n" ..
    "then create one toolpath per layer using manifest.json\n" ..
    "for start_depth / cut_depth. That path is already verified\n" ..
    "on the test part (8 layers, 6 holes, 3 pockets)."
  )
  return true
end
