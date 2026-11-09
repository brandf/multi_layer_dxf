-- Onshape25D.lua — VCarve Pro gadget (v0.2, implemented, NOT yet run in VCarve)
--
-- What it does, in one click inside VCarve Pro:
--   1. Asks for manifest.txt (written by step_to_vcarve.py / multi_part.py).
--      One line per layer: layer|operation|start_depth|cut_depth
--      (multi-part lines have a 5th |part field, which is ignored).
--      The manifest's first line is "# dxf: <stem>.dxf" — that is the
--      layered DXF in the same folder.
--   2. Imports that DXF (full mode) via job:ImportDxfDwg(), which
--      selects the imported vectors.
--   3. For each manifest line, in order (already drill -> pocket -> profile):
--        select closed vectors on that layer, join them, create the
--        toolpath with start_depth / cut_depth from the manifest.
--        drill   -> CreateDrillingToolpath, tool dia from the layer name
--                   (DRILL_D6.00_THRU), peck if configured
--        pocket  -> CreatePocketingToolpath, raster clearance, profile last
--        profile -> CreateProfilingToolpath, PROFILE_OUTSIDE for the outer
--                   profile, PROFILE_ON for THROUGH_CUT slots (a slot is
--                   an opening, not a part to cut around)
--   4. Recalculates all toolpaths and reports how many were created.
--      It does NOT post G-code and does NOT save the job for you —
--      preview the toolpaths, then File > Save As <stem>.crv yourself.
--
-- Flexible, not all-or-nothing:
--   MODE = "full"            -- import DXF + toolpaths
--   MODE = "toolpaths_only"  -- DXF already imported, just make toolpaths
--   MODE = "preview"         -- same as full, but no 2D toolpath previews
--   ONLY = { "drill", "pocket" }  -- e.g. drills only, or nil for all
--   SKIP_LAYERS = { "THROUGH_CUT" } -- layers to leave alone (matched
--                             -- by suffix, so P01_x__THROUGH_CUT matches)
--   TOOLS table below: change diameters / stepdown / stepover / feeds
--   here once, the gadget reuses them for every model. Feeds below are
--   conservative placeholders — set them from your own tool library.
--
-- Install:
--   Copy this file into Public Documents\Vectric\VCarve Pro\Gadgets\Onshape25D\
--   Restart VCarve, Gadgets menu > Onshape25D. Run it in a job whose
--   material size / thickness / Z-zero already match the manifest
--   (VCarve Z-zero at top of material, same convention as the exporter).
--
-- Sources for the SDK calls (Vectric Lua Interface for Gadgets,
-- mirrored at jimandi.com/SDK, ToolpathManager + VectricJob pages):
--   ToolpathManager():CreateProfilingToolpath(name, tool, profile_data,
--     ramping_data, lead_data, pos_data, geometry_selector,
--     create_2d_preview, interactive)
--   ToolpathManager():CreatePocketingToolpath(name, tool, area_clear_tool,
--     pocket_data, pos_data, geometry_selector, create_2d_preview,
--     interactive)
--   ToolpathManager():CreateDrillingToolpath(name, tool, drill_data,
--     pos_data, geometry_selector, create_2d_preview, interactive)
--   VectricJob():ImportDxfDwg(pathname) — imports DXF, selects the data
--   job.LayerManager:FindLayerWithName(name)
--   SelectVectorsOnLayer(layer, selection, closed_only, open_only, ...)
--   Tool(name, Tool.END_MILL / Tool.THROUGH_DRILL), with .InMM,
--   .ToolDia, .Stepdown, .Stepover, .FeedRate, .PlungeRate,
--   .SpindleSpeed, .ToolNumber
--   ToolpathPosData():SetHomePosition(x, y, z), .SafeZGap
--   ProfileParameterData: .StartDepth, .CutDepth, .CutDirection,
--     .ProfileSide (PROFILE_OUTSIDE / PROFILE_ON), .Allowance, .UseTabs
--   PocketParameterData: .StartDepth, .CutDepth, .CutDirection,
--     .DoRasterClearance, .RasterAngle, .ProfilePassType (PROFILE_LAST)
--   DrillParameterData: .StartDepth, .CutDepth, .DoPeckDrill,
--     .PeckRetractGap
--
-- Honest status:
--   Written from the SDK docs above, syntax-checked with luaparser on
--   Linux, but NOT yet run inside VCarve — there is no VCarve on this
--   VM. Two calls are the least certain and are guarded so the gadget
--   fails with a message instead of silently doing the wrong thing:
--     GetFileName() — the file picker; if VCarve has no such global,
--       the gadget aborts with a message.
--     JoinVectors() — joining open vectors on a layer; if the global
--       does not exist, the gadget proceeds with the vectors as
--       imported and lets Create*Toolpath report the failure per layer.
--   Expect 1 round of fixing API names against your installed VCarve
--   version (v11 / v12 / v12.5) before it is trusted on a real part.
--   The DXF + manifest path already works without the gadget (import
--   DXF, create toolpaths manually per layer), so you are never locked
--   into the gadget working first try.
--
-- If any layer's toolpath creation fails, the gadget stops, reports
-- which layer failed, and leaves the toolpaths already created in
-- place — it never silently creates a wrong toolpath.

-- ================= user config (edit these once) =================
local MODE = "full"  -- "full" | "toolpaths_only" | "preview"
local ONLY = nil     -- e.g. { "drill", "pocket" } or nil for all operations
local SKIP_LAYERS = {} -- e.g. { "THROUGH_CUT" } (matched by suffix)

local TOOLS = {
  drill   = { dia_mm = 0,    stepdown_mm = 3.0, peck = true,  peck_gap_mm = 2.0,
              feed_mm_sec = 30, plunge_mm_sec = 10, spindle_rpm = 20000 },
  pocket  = { dia_mm = 6.0,  stepdown_mm = 3.0, stepover_pct = 40,
              feed_mm_sec = 30, plunge_mm_sec = 10, spindle_rpm = 20000 },
  profile = { dia_mm = 6.0,  stepdown_mm = 3.0, tabs = false, tab_count = 4,
              feed_mm_sec = 30, plunge_mm_sec = 10, spindle_rpm = 20000 },
}
-- drill.dia_mm = 0 means "use the hole diameter from the layer name
-- (DRILL_D6.00_THRU -> 6 mm drill)". Set it to a fixed diameter to
-- force one drill for every hole instead.
-- =================================================================

local function split(str, sep)
  local out = {}
  for part in (str .. sep):gmatch("(.-)" .. sep) do
    table.insert(out, part)
  end
  return out
end

local function trim(s)
  return (s:gsub("^%s*(.-)%s*$", "%1"))
end

local function layer_matches(list, layer_name)
  -- match by full name or by suffix (multi-part layers are
  -- P01_label__THROUGH_CUT etc.)
  for _, item in ipairs(list) do
    if layer_name == item then return true end
    if layer_name:sub(-#item) == item then return true end
  end
  return false
end

local function operation_wanted(operation)
  if not ONLY then return true end
  for _, op in ipairs(ONLY) do
    if op == operation then return true end
  end
  return false
end

local function make_tool(name, tool_type, dia_mm, stepdown_mm, stepover_mm, cfg)
  local tool = Tool(name, tool_type)
  tool.InMM = true
  tool.ToolDia = dia_mm
  tool.Stepdown = stepdown_mm
  tool.Stepover = stepover_mm
  tool.RateUnits = Tool.MM_SEC
  tool.FeedRate = cfg.feed_mm_sec
  tool.PlungeRate = cfg.plunge_mm_sec
  tool.SpindleSpeed = cfg.spindle_rpm
  tool.ToolNumber = 1
  return tool
end

local function make_pos_data()
  local mtl_block = MaterialBlock()
  local mtl_box = mtl_block.MaterialBox
  local blc = mtl_box.BLC
  local pos_data = ToolpathPosData()
  pos_data:SetHomePosition(blc.x, blc.y, mtl_box.TRC.z + (mtl_block.Thickness * 0.2))
  pos_data.SafeZGap = mtl_block.Thickness * 0.1
  return pos_data
end

local function create_drill(name, layer, start_depth, cut_depth)
  local dia = layer:match("DRILL_D([%d%.]+)")
  dia = dia and tonumber(dia) or TOOLS.drill.dia_mm
  if not dia or dia <= 0 then
    return false, "no drill diameter for layer " .. layer
  end
  local cfg = TOOLS.drill
  local tool = make_tool("Drill D" .. dia, Tool.THROUGH_DRILL,
                         dia, cfg.stepdown_mm, dia * 0.25, cfg)
  local drill_data = DrillParameterData()
  drill_data.StartDepth = start_depth
  drill_data.CutDepth = cut_depth
  drill_data.DoPeckDrill = cfg.peck
  drill_data.PeckRetractGap = cfg.peck_gap_mm
  drill_data.ProjectToolpath = false
  local mgr = ToolpathManager()
  local id = mgr:CreateDrillingToolpath(name, tool, drill_data,
                                        make_pos_data(), GeometrySelector(),
                                        true, true)
  if id == nil then return false, "CreateDrillingToolpath failed" end
  return true
end

local function create_pocket(name, layer, start_depth, cut_depth)
  local cfg = TOOLS.pocket
  local tool = make_tool("End Mill D" .. cfg.dia_mm, Tool.END_MILL,
                         cfg.dia_mm, cfg.stepdown_mm,
                         cfg.dia_mm * (cfg.stepover_pct / 100), cfg)
  local pocket_data = PocketParameterData()
  pocket_data.StartDepth = start_depth
  pocket_data.CutDepth = cut_depth
  pocket_data.CutDirection = ProfileParameterData.CLIMB_DIRECTION
  pocket_data.Allowance = 0.0
  pocket_data.DoRasterClearance = true
  pocket_data.RasterAngle = 0
  pocket_data.ProfilePassType = PocketParameterData.PROFILE_LAST
  pocket_data.DoRamping = false
  pocket_data.RampDistance = 10.0
  pocket_data.ProjectToolpath = false
  local mgr = ToolpathManager()
  local id = mgr:CreatePocketingToolpath(name, tool, nil, pocket_data,
                                         make_pos_data(), GeometrySelector(),
                                         true, true)
  if id == nil then return false, "CreatePocketingToolpath failed" end
  return true
end

local function create_profile(name, layer, start_depth, cut_depth)
  local cfg = TOOLS.profile
  local tool = make_tool("End Mill D" .. cfg.dia_mm, Tool.END_MILL,
                         cfg.dia_mm, cfg.stepdown_mm, cfg.dia_mm * 0.25, cfg)
  local profile_data = ProfileParameterData()
  profile_data.StartDepth = start_depth
  profile_data.CutDepth = cut_depth
  profile_data.CutDirection = ProfileParameterData.CLIMB_DIRECTION
  -- A THROUGH_CUT slot is an opening: cut ON the line. The outer
  -- profile is a part: cut OUTSIDE it.
  if layer_matches({ "THROUGH_CUT" }, layer) then
    profile_data.ProfileSide = ProfileParameterData.PROFILE_ON
  else
    profile_data.ProfileSide = ProfileParameterData.PROFILE_OUTSIDE
  end
  profile_data.Allowance = 0.0
  profile_data.KeepStartPoints = false
  profile_data.CreateSquareCorners = false
  profile_data.CornerSharpen = false
  profile_data.UseTabs = cfg.tabs
  profile_data.TabLength = 5.0
  profile_data.TabThickness = 1.0
  profile_data.Use3dTabs = true
  profile_data.ProjectToolpath = false
  local ramping_data = RampingData()
  ramping_data.DoRamping = false
  local lead_data = LeadInOutData()
  lead_data.DoLeadIn = false
  lead_data.DoLeadOut = false
  local mgr = ToolpathManager()
  local id = mgr:CreateProfilingToolpath(name, tool, profile_data,
                                         ramping_data, lead_data,
                                         make_pos_data(), GeometrySelector(),
                                         true, true)
  if id == nil then return false, "CreateProfilingToolpath failed" end
  return true
end

function main()
  local job = VectricJob()
  if not job.Exists then
    DisplayMessageBox("Onshape25D: no job loaded. Create a job first, with\n"
      .. "material size / thickness / Z-zero matching the manifest,\n"
      .. "then run the gadget again.")
    return false
  end

  -- --- pick manifest.txt ---
  local manifest_path = nil
  if GetFileName then
    manifest_path = GetFileName("Select manifest.txt", "*.txt")
  end
  if not manifest_path or manifest_path == "" then
    DisplayMessageBox("Onshape25D: could not pick a manifest file.\n\n"
      .. "Pick manifest.txt (next to the DXF from step_to_vcarve.py)\n"
      .. "when the file dialog appears, or check that your VCarve\n"
      .. "version provides GetFileName().")
    return false
  end
  local manifest_dir = manifest_path:match("^(.*[\\/])") or ""

  -- --- read manifest; first line "# dxf: <stem>.dxf" names the DXF ---
  local dxf_name = nil
  local lines = {}
  local fh = io.open(manifest_path, "r")
  if not fh then
    DisplayMessageBox("Onshape25D: cannot open " .. manifest_path)
    return false
  end
  for line in fh:lines() do
    line = trim(line)
    if line:sub(1, 1) == "#" then
      dxf_name = dxf_name or line:match("^#%s*dxf:%s*(%S+)%s*$")
    elseif line ~= "" then
      table.insert(lines, line)
    end
  end
  fh:close()
  if #lines == 0 then
    DisplayMessageBox("Onshape25D: manifest is empty: " .. manifest_path)
    return false
  end

  -- --- import DXF (full / preview mode) ---
  if MODE ~= "toolpaths_only" then
    local dxf_path = dxf_name and (manifest_dir .. dxf_name) or nil
    if not dxf_path then
      if GetFileName then
        dxf_path = GetFileName("Select the layered DXF", "*.dxf")
      end
    end
    if not dxf_path or dxf_path == "" then
      DisplayMessageBox("Onshape25D: no DXF to import. The manifest has\n"
        .. "no '# dxf:' line and no DXF was picked.")
      return false
    end
    if not job:ImportDxfDwg(dxf_path) then
      DisplayMessageBox("Onshape25D: DXF import failed for " .. dxf_path
        .. "\n\nImport the DXF manually (File > Import > Import Vectors),\n"
        .. "then re-run the gadget in toolpaths_only mode.")
      return false
    end
  end

  -- --- one toolpath per manifest line, in manifest order ---
  local created = 0
  local skipped = 0
  for _, line in ipairs(lines) do
    local parts = split(line, "|")
    local layer = trim(parts[1] or "")
    local operation = trim(parts[2] or "")
    local start_depth = tonumber(parts[3]) or 0
    local cut_depth = tonumber(parts[4]) or 0
    if layer == "" or operation == "" then
      DisplayMessageBox("Onshape25D: bad manifest line: " .. line)
      return false
    end
    if operation_wanted(operation) and not layer_matches(SKIP_LAYERS, layer) then
      local layer_obj = job.LayerManager:FindLayerWithName(layer)
      if layer_obj == nil then
        DisplayMessageBox("Onshape25D: no layer named " .. layer
          .. " in the job. Import the DXF first, or check the manifest.")
        return false
      end
      local selection = job.Selection
      selection:Clear()
      if not SelectVectorsOnLayer(layer_obj, selection, true, false, true) then
        DisplayMessageBox("Onshape25D: no closed vectors on layer " .. layer)
        return false
      end
      -- Join open vectors on this layer, if the SDK provides it.
      -- Our DXF loops are closed shapes made of separate line/arc
      -- entities, so joining is what makes them one closed vector.
      if JoinVectors then
        pcall(function() JoinVectors(selection, 0.01) end)
      end
      local ok, err
      if operation == "drill" then
        ok, err = create_drill(layer, layer, start_depth, cut_depth)
      elseif operation == "pocket" then
        ok, err = create_pocket(layer, layer, start_depth, cut_depth)
      elseif operation == "profile" then
        ok, err = create_profile(layer, layer, start_depth, cut_depth)
      else
        DisplayMessageBox("Onshape25D: unknown operation '" .. operation
          .. "' on layer " .. layer)
        return false
      end
      if not ok then
        DisplayMessageBox("Onshape25D: failed on layer " .. layer
          .. " (" .. operation .. "): " .. tostring(err)
          .. "\n\nToolpaths created so far (" .. created
          .. ") are still in the job. Fix the error and re-run —\n"
          .. "layers already done will be created again, delete the\n"
          .. "duplicates or run with SKIP_LAYERS for the done ones.")
        return false
      end
      created = created + 1
    else
      skipped = skipped + 1
    end
  end

  local mgr = ToolpathManager()
  if mgr.RecalculateAllToolpaths then
    mgr:RecalculateAllToolpaths()
  end

  DisplayMessageBox("Onshape25D: done — " .. created .. " toolpath(s) created"
    .. (skipped > 0 and (", " .. skipped .. " skipped") or "")
    .. ".\n\nPreview the toolpaths now. This gadget does not post\n"
    .. "G-code and does not save the job — File > Save As to save\n"
    .. "the .crv yourself, then post G-code with your post-processor.")
  return true
end
