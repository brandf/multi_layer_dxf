-- VECTRIC LUA SCRIPT
-- multi_layer_dxf.lua — VCarve Pro gadget (v0.5, live-tested in VCarve Pro V12.5)
-- NOTE: the first line is required — VCarve refuses to load a gadget
-- whose first line is not exactly "-- VECTRIC LUA SCRIPT".
--
-- What it does, in one click inside VCarve Pro:
--   1. Asks for manifest.txt (written by step_to_vcarve.py / multi_part.py).
--      One line per layer, in cut order:
--        layer|operation|start_depth|cut_depth|part|tool_id|allowance|kind
--      (v0.2 manifests have only the first 4 fields — still accepted,
--      the gadget then falls back to the TOOLS table below; v0.3
--      manifests stop at field 6, allowance defaults to 0.)
--      Field 7 is the wall allowance in mm (a rough pass leaves it,
--      a finish pass removes it); field 8 is the pass kind
--      (rough/finish — two toolpaths on one layer get different names).
--      Comment lines at the top carry the rest of the plan:
--        # dxf: <stem>.dxf            — the layered DXF, same folder
--        # plan: <id> — N tool(s), M change(s), est X min
--        # tool: <id>|<kind>|<dia>|<number>|<feed>|<plunge>|<spindle>|<stepdown>|<stepover>
--        # tabs: <layer>|<count>|<length_mm>|<thickness_mm>
--   2. Imports that DXF (full mode) via job:ImportDxfDwg().
--   3. TOOLS: for each distinct tool in the plan it tries to match the
--      recommendation to a tool in YOUR VCarve tool library
--      (ToolDatabase:SelectTool() — the SDK has no silent lookup by
--      diameter, only the interactive dialog). One tool at a time:
--      it names the tool it needs, then opens that tool's library
--      dialog; Cancel uses the recommendation as-is, creating a tool
--      with the recommended diameter/feeds. Set MATCH_TO_LIBRARY =
--      false to skip the dialogs and always use the recommendations.
--      A picked tool is remembered (REMEMBER_TOOLS, registry) and
--      reused without asking on the next run.
--      Tools get distinct numbers in first-use order (v0.2 made every
--      toolpath Tool 1, so the posted code called no tool change).
--   4. For each manifest line, in order (already drill -> pocket ->
--      profile, grouped by tool): select closed vectors on that layer
--      (profile layers get their tabs placed on the vectors first),
--      create the toolpath with start_depth / cut_depth
--      from the manifest and the resolved tool.
--        drill   -> CreateDrillingToolpath, peck if configured
--        pocket  -> CreatePocketingToolpath, raster clearance, profile last
--        profile -> CreateProfilingToolpath, PROFILE_OUTSIDE for the outer
--                   profile, PROFILE_ON for THROUGH_CUT slots (a closed
--                   loop cut on the line). BOTH get TABS from the # tabs
--                   line when one exists: the outer profile frees the
--                   part, a through cut frees the slug inside it (a
--                   doughnut hole's centre is a solid disc, not sawdust),
--                   and either goes flying without tabs. Tabs are placed
--                   as real ToolpathTab objects on the vectors first
--                   (UseTabs alone creates none — Nov 22 live test).
--   5. Recalculates all toolpaths and reports the tools used, with
--      their source (your library vs the recommendation).
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
--   MATCH_TO_LIBRARY = true  -- pick each recommended tool from your
--                             -- VCarve tool library (one dialog per tool,
--                             -- named first); REMEMBER_TOOLS = true
--                             -- reuses a picked tool next run, no dialog
--   TOOLS table below: fallback diameters / stepdown / stepover / feeds
--   for old manifests without # tool lines. Feeds below are
--   conservative placeholders — set them from your own tool library.
--
-- Install:
--   Gadgets > Install New Gadget, pick multi_layer_dxf.vgadget
--   (build it with make_vgadget.py, or double-click the .vgadget),
--   or copy this file into Public Documents\Vectric\VCarve Pro\Gadgets\multi_layer_dxf\
--   Restart VCarve, Gadgets menu > multi_layer_dxf. Run it in a job whose
--   material size / thickness / Z-zero already match the manifest
--   (VCarve Z-zero at top of material, same convention as the exporter).
--
-- Sources for the SDK calls (Vectric Lua Interface for Gadgets,
-- mirrored at jimandi.com/SDK, ToolpathManager + VectricJob +
-- ToolDatabase + Tool pages):
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
--   Layer selection is a local helper below (adapted from Vectric's
--     Profile_Vectors_On_Layer sample): layer:GetHeadPosition() /
--     GetNext(pos), object:GetContour(), selection:Add(object, ...),
--     selection:GroupSelectionFinished(). There is NO global
--     SelectVectorsOnLayer in the API — calling it as one crashes
--     the gadget (VCarve V12.5 live test, Nov 21).
--   Tool(name, Tool.END_MILL / Tool.THROUGH_DRILL), with .InMM,
--     .ToolDia, .Stepdown, .Stepover, .FeedRate, .PlungeRate,
--     .SpindleSpeed, .ToolNumber
--   ToolDatabase():SelectTool() — shows the Tool Database dialog,
--     returns the tool the user picks (or nil on Cancel). GetTool(id)
--     returns a tool by database id. There is NO search-by-diameter.
--   FileDialog():FileOpen(default_ext, file_name, filter) — the
--     standard file picker; the chosen path is in .PathName.
--     Confirmed from the official V12 Gadget SDK (Lua Interface
--     Documentation p.198 + the IFS_Fractal / List_Folders samples).
--     GetFileName() does NOT exist in the Vectric API — the Nov 21
--     live test proved it: no dialog ever appeared.
--   ToolpathPosData():SetHomePosition(x, y, z), .SafeZGap
--   ProfileParameterData: .StartDepth, .CutDepth, .CutDirection,
--     .ProfileSide (PROFILE_OUTSIDE / PROFILE_ON), .Allowance, .UseTabs,
--     .TabLength, .TabThickness, .Use3dTabs
--   PocketParameterData: .StartDepth, .CutDepth, .CutDirection,
--     .DoRasterClearance, .RasterAngle, .ProfilePassType (PROFILE_LAST)
--   DrillParameterData: .StartDepth, .CutDepth, .DoPeckDrill,
--     .PeckRetractGap
--
-- Honest status:
--   Live-tested in VCarve Pro V12.5 (Nov 21-22): installs, picks the
--   manifest, imports the DXF, matches tools, creates 8 toolpaths for
--   the real container. Least-certain calls, all guarded so the gadget
--   fails with a message instead of silently doing the wrong thing:
--     FileDialog() — the file picker (confirmed, V12 SDK docs +
--       samples). Guarded anyway: if a VCarve version lacks it, the
--       gadget says so and MANIFEST_PATH is the fallback.
--     JoinVectors() does NOT exist in the V12 SDK (zero matches in
--       the docs or the samples) — the old guarded call was dead code
--       and is removed. DXF import already produces closed contours,
--       which is what selection works on; if a layer ever has none,
--       the gadget reports it instead of guessing.
--     ToolDatabase():SelectTool() — library matching; if the API is
--       missing or you Cancel, the gadget uses the recommendation.
--       Tool.ToolDia is in the tool's own units — read Tool.InMM
--       first (a 1/4 in library tool reports 0.25, not 6.35).
--     ToolDBId registry persistence (REMEMBER_TOOLS) and
--       CadContour:InsertToolpathAtTabAtPoint (tabs) are new in v0.5
--       and untested in VCarve: a failed load just asks again, and a
--       failed tab placement warns in the final message while VCarve's
--       own "No tabs defined" dialog still fires as a backstop.
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
local MATCH_TO_LIBRARY = true -- pick each recommended tool from your
                              -- VCarve tool library (one dialog per tool);
                              -- Cancel uses the recommendation as-is
local REMEMBER_TOOLS = true   -- remember each picked library tool in
                              -- the registry (ToolDBId defaults), keyed
                              -- by the manifest tool id (EM6.35, D2.25):
                              -- the next run reuses it without asking.
                              -- Set false to always ask. A remembered
                              -- tool is re-asked if its diameter no
                              -- longer matches the recommendation.
local MANIFEST_PATH = nil -- Optional override, e.g.
                          -- [[C:\cnc\multi_layer_dxf\test\real_container_out\manifest.txt]]
                          -- Leave it nil (the default) and the gadget
                          -- shows the standard file dialog so you can
                          -- pick manifest.txt. Set it only to skip the
                          -- dialog for a repeat run of the same job.

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
-- force one drill for every hole instead. TOOLS is only the fallback
-- for manifests without # tool lines; v2 manifests carry the plan.
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

-- Diameter label for messages: metric always, plus the inch size when
-- it is a standard imperial endmill (6.35 mm is 1/4 in — the size the
-- library is browsed by). Drills stay metric.
local INCH_ENDMILLS = { [12.7] = "1/2 in", [9.53] = "3/8 in",
  [6.35] = "1/4 in", [4.76] = "3/16 in", [3.17] = "1/8 in",
  [1.59] = "1/16 in" }
local function dia_label(dia_mm)
  local key = math.floor(dia_mm * 100 + 0.5) / 100
  local inch = INCH_ENDMILLS[key]
  local label = string.format("%.2f", dia_mm) .. " mm"
  if inch ~= nil then label = label .. " (" .. inch .. ")" end
  return label
end

-- Diameter of a library tool in mm. ToolDia is in the tool's own
-- units: a 1/4 in library tool reports ToolDia 0.25 with InMM false
-- (live test, Nov 22: the gadget warned "picked a 0.25 mm tool"
-- for a correctly picked 1/4 in endmill — the toolpaths were right,
-- the comparison was wrong). InMM nil/missing means mm.
local function tool_dia_mm(tool)
  local ok_d, dia = pcall(function() return tool.ToolDia end)
  if not ok_d or dia == nil then return nil end
  local ok_u, in_mm = pcall(function() return tool.InMM end)
  if ok_u and in_mm == false then dia = dia * 25.4 end
  return dia
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

local function make_tool(name, tool_type, dia_mm, stepdown_mm, stepover_mm, cfg, tool_number)
  local tool = Tool(name, tool_type)
  tool.InMM = true
  tool.ToolDia = dia_mm
  tool.Stepdown = stepdown_mm
  tool.Stepover = stepover_mm
  tool.RateUnits = Tool.MM_SEC
  tool.FeedRate = cfg.feed_mm_sec
  tool.PlungeRate = cfg.plunge_mm_sec
  tool.SpindleSpeed = cfg.spindle_rpm
  tool.ToolNumber = tool_number or 1
  return tool
end

local function tool_type_for(kind)
  if kind == "drill" then return Tool.THROUGH_DRILL end
  return Tool.END_MILL
end

-- Remembered tools: a library pick is saved in the registry with
-- ToolDBId:SaveDefaults (the SDK's own persistence: "useful for
-- saving and loading defaults"), keyed by the manifest tool id, so
-- the next run reuses it without asking. A remembered tool whose
-- diameter no longer matches the recommendation is discarded and
-- asked again. Everything is guarded: a failed load just asks.
local function remembered_tool(db, key)
  if not REMEMBER_TOOLS then return nil end
  local ok_id, id = pcall(function() return ToolDBId("multi_layer_dxf", key) end)
  if not ok_id or id == nil then return nil end
  pcall(function() id:LoadDefaults("multi_layer_dxf", key) end)
  local ok_tool, tool = pcall(function() return db:GetTool(id) end)
  if ok_tool and tool ~= nil then return tool end
  return nil
end

local function remember_tool(picked, key)
  if not REMEMBER_TOOLS then return end
  local ok_id, id = pcall(function() return picked.ToolDBId end)
  if ok_id and id ~= nil then
    pcall(function() id:SaveDefaults("multi_layer_dxf", key) end)
  end
end

-- Resolve the plan's tools: match each recommendation to the VCarve
-- tool library when asked (one dialog per distinct tool), else create
-- a tool from the recommendation. Returns tool_id -> {tool=, source=,
-- dia_mm=, number=} and a list of warning strings.
local function resolve_tools(plan_tools)
  local resolved = {}
  local warnings = {}
  local use_dialog = MATCH_TO_LIBRARY and ToolDatabase ~= nil
  local db = nil
  if use_dialog then
    local ok_db, db_obj = pcall(function() return ToolDatabase() end)
    if ok_db then db = db_obj end
  end
  for i, t in ipairs(plan_tools) do
    local tool = nil
    local source = "recommendation"
    if db ~= nil then
      -- First: a remembered pick from an earlier run — no dialog.
      tool = remembered_tool(db, t.id)
      if tool ~= nil then
        local dia = tool_dia_mm(tool)
        if dia ~= nil and math.abs(dia - t.dia_mm) > 0.05 then
          tool = nil -- library tool drifted; ask again below
        else
          source = "remembered from your library"
          local ok_n, num = pcall(function() return tool.ToolNumber end)
          if ok_n and num ~= nil then t.tool_number = num end
        end
      end
      if tool == nil then
        -- One tool at a time, named first: say which tool is needed,
        -- then open its library dialog. The old flow listed every tool
        -- up front in one message and then popped the dialogs back to
        -- back with nothing saying which was which (Brandon, Nov 22).
        DisplayMessageBox("Tool " .. i .. " of " .. #plan_tools
          .. " — pick the " .. t.name .. " from your VCarve library.\n"
          .. "Feed " .. t.feed_mm_sec .. " mm/s, plunge "
          .. t.plunge_mm_sec .. " mm/s, " .. t.spindle_rpm .. " rpm.\n"
          .. "Cancel uses this recommendation as-is.")
        local ok_pick, picked = pcall(function() return db:SelectTool() end)
        if ok_pick and picked ~= nil then
          tool = picked
          source = "your VCarve library"
          local dia = tool_dia_mm(picked)
          if dia ~= nil and math.abs(dia - t.dia_mm) > 0.05 then
            table.insert(warnings, t.name .. ": you picked a "
              .. string.format("%.2f", dia) .. " mm tool instead of "
              .. string.format("%.2f", t.dia_mm)
              .. " mm — the cut will use the picked tool")
          end
          local ok_n, num = pcall(function() return picked.ToolNumber end)
          if ok_n and num ~= nil then t.tool_number = num end
          remember_tool(picked, t.id)
        end
      end
    end
    if tool == nil then
      tool = make_tool(t.name, tool_type_for(t.kind), t.dia_mm,
                       t.stepdown_mm, t.stepover_mm,
                       { feed_mm_sec = t.feed_mm_sec,
                         plunge_mm_sec = t.plunge_mm_sec,
                         spindle_rpm = t.spindle_rpm },
                       t.tool_number)
    end
    resolved[t.id] = { tool = tool, source = source,
                       dia_mm = t.dia_mm, number = t.tool_number,
                       name = t.name }
  end
  return resolved, warnings
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

local function create_drill(name, layer, start_depth, cut_depth, tool, peck_gap_mm)
  local drill_data = DrillParameterData()
  drill_data.StartDepth = start_depth
  drill_data.CutDepth = cut_depth
  drill_data.DoPeckDrill = true
  drill_data.PeckRetractGap = peck_gap_mm or 2.0
  drill_data.ProjectToolpath = false
  local mgr = ToolpathManager()
  local id = mgr:CreateDrillingToolpath(name, tool, drill_data,
                                        make_pos_data(), GeometrySelector(),
                                        true, true)
  if id == nil then return false, "CreateDrillingToolpath failed" end
  return true
end

local function create_pocket(name, layer, start_depth, cut_depth, tool, allowance_mm)
  local pocket_data = PocketParameterData()
  pocket_data.StartDepth = start_depth
  pocket_data.CutDepth = cut_depth
  pocket_data.CutDirection = ProfileParameterData.CLIMB_DIRECTION
  -- A rough pass leaves `allowance_mm` on the walls; the finish pass
  -- (allowance 0) removes it and sharpens the corners.
  pocket_data.Allowance = allowance_mm or 0.0
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

-- Place tabs on a profile layer's closed contours: VCarve's
-- ProfileParameterData.UseTabs only USES tabs that already exist on
-- the vectors — setting it alone creates none, and the toolpath is
-- calculated with the "No tabs defined on selected vectors" warning
-- (live test, Nov 22: the profiles had no tabs). So tabs are placed
-- here as real ToolpathTab objects, evenly spaced around each closed
-- contour, BEFORE the profile toolpath is created.
-- InsertToolpathAtTabAtPoint snaps to the closest point on the
-- contour, so points on a circle around the contour's bounding-box
-- centre land evenly spaced on the contour itself. Returns the
-- number of tabs placed.
local function place_tabs_on_layer(layer_obj, count)
  if count == nil or count <= 0 then return 0 end
  local placed = 0
  local pos = layer_obj:GetHeadPosition()
  while pos ~= nil do
    local object
    object, pos = layer_obj:GetNext(pos)
    local contour = object:GetContour()
    if contour ~= nil and not contour.IsOpen then
      local ok, n = pcall(function()
        local box = contour.BoundingBox2D
        if box == nil or box.IsInvalid then
          box = object:GetBoundingBox()
        end
        if box == nil or box.IsInvalid then return 0 end
        local cx, cy = box.Centre.x, box.Centre.y
        local rx = box.XLength * 0.5
        local ry = box.YLength * 0.5
        local radius = math.sqrt(rx * rx + ry * ry)
        if radius <= 0 then return 0 end
        local cad = CastCadObjectToCadContour(object)
        if cad == nil then return 0 end
        local m = 0
        for k = 1, count do
          -- Half-step offset: no tab lands exactly at angle 0,
          -- where a profile toolpath typically starts.
          local angle = (k - 0.5) * 2 * math.pi / count
          local px = cx + radius * math.cos(angle)
          local py = cy + radius * math.sin(angle)
          local ok_tab = pcall(function()
            return cad:InsertToolpathAtTabAtPoint(Point2D(px, py))
          end)
          if ok_tab then m = m + 1 end
        end
        return m
      end)
      if ok and type(n) == "number" then placed = placed + n end
    end
  end
  return placed
end

local function create_profile(name, layer, start_depth, cut_depth, tool, tabs)
  local profile_data = ProfileParameterData()
  profile_data.StartDepth = start_depth
  profile_data.CutDepth = cut_depth
  profile_data.CutDirection = ProfileParameterData.CLIMB_DIRECTION
  -- A THROUGH_CUT is a closed loop: cut ON the line. The outer
  -- profile is a part: cut OUTSIDE it. Either way, if the manifest
  -- carries a # tabs line for this layer, apply it — the loop frees
  -- a separate piece (the part, or the slug inside a through cut)
  -- and it goes flying without tabs.
  if layer_matches({ "THROUGH_CUT" }, layer) then
    profile_data.ProfileSide = ProfileParameterData.PROFILE_ON
  else
    profile_data.ProfileSide = ProfileParameterData.PROFILE_OUTSIDE
  end
  if tabs ~= nil then
    -- UseTabs only USES tabs that already exist on the vectors;
    -- the tabs themselves are placed by place_tabs_on_layer (called
    -- from main() before this runs). Tab length/thickness come from
    -- the manifest; there is no TabCount property to set.
    profile_data.UseTabs = true
    profile_data.TabLength = tabs.length_mm
    profile_data.TabThickness = tabs.thickness_mm
    profile_data.Use3dTabs = true
  end
  profile_data.Allowance = 0.0
  profile_data.KeepStartPoints = false
  profile_data.CreateSquareCorners = false
  profile_data.CornerSharpen = false
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

-- Fallback tool for old manifests (no # tool lines): v0.2 behaviour.
local function fallback_tool(operation, layer)
  if operation == "drill" then
    local dia = layer:match("DRILL_D([%d%.]+)")
    dia = dia and tonumber(dia) or TOOLS.drill.dia_mm
    if not dia or dia <= 0 then return nil, "no drill diameter for layer " .. layer end
    local cfg = TOOLS.drill
    return make_tool("Drill D" .. dia, Tool.THROUGH_DRILL,
                     dia, cfg.stepdown_mm, dia * 0.25, cfg, 1), nil
  elseif operation == "pocket" then
    local cfg = TOOLS.pocket
    return make_tool("End Mill D" .. cfg.dia_mm, Tool.END_MILL,
                     cfg.dia_mm, cfg.stepdown_mm,
                     cfg.dia_mm * (cfg.stepover_pct / 100), cfg, 1), nil
  else
    local cfg = TOOLS.profile
    return make_tool("End Mill D" .. cfg.dia_mm, Tool.END_MILL,
                     cfg.dia_mm, cfg.stepdown_mm, cfg.dia_mm * 0.25, cfg, 1), nil
  end
end

-- SelectVectorsOnLayer — adapted from Vectric's Profile_Vectors_On_Layer
-- sample gadget (V12 SDK; Vectric's own code, used with its licence
-- terms: origin must not be misrepresented, altered versions marked).
-- The sample defines this helper itself because the API has no such
-- global. One fix vs the sample: the sample's nested if/else adds an
-- OPEN contour when select_closed is true and select_open is false;
-- here open/closed are tested exactly (IsOpen and select_open, or
-- not IsOpen and select_closed).
local function SelectVectorsOnLayer(layer, selection, select_closed, select_open, select_groups)
  local objects_selected = false
  local warning_displayed = false
  local pos = layer:GetHeadPosition()
  while pos ~= nil do
    local object
    object, pos = layer:GetNext(pos)
    local contour = object:GetContour()
    if contour == nil then
      if (object.ClassName == "vcCadObjectGroup") and select_groups then
        selection:Add(object, true, true)
        objects_selected = true
      else
        if not warning_displayed then
          local message = "Object(s) without contour information found on layer - ignoring"
          if not select_groups then
            message = message .. "\r\n\r\n"
              .. "If layer contains grouped vectors these must be ungrouped for this script"
          end
          DisplayMessageBox(message)
          warning_displayed = true
        end
      end
    else
      local is_open = contour.IsOpen
      if (is_open and select_open) or ((not is_open) and select_closed) then
        selection:Add(object, true, true)
        objects_selected = true
      end
    end
  end
  -- Vectors were added in batch mode; tell the selection we are done.
  if objects_selected then
    selection:GroupSelectionFinished()
  end
  return objects_selected
end

function main()
  local job = VectricJob()
  if not job.Exists then
    DisplayMessageBox("multi_layer_dxf: no job loaded. Create a job first, with\n"
      .. "material size / thickness / Z-zero matching the manifest,\n"
      .. "then run the gadget again.")
    return false
  end

  -- --- pick manifest.txt ---
  -- MANIFEST_PATH (top of this file) wins when set. Otherwise the
  -- standard file dialog lets you pick the file: FileDialog() is the
  -- documented Vectric API (V12 SDK, Lua Interface Documentation
  -- p.198; IFS_Fractal sample). GetFileName() does NOT exist in the
  -- Vectric API — the Nov 21 live test proved it: no dialog appeared.
  local manifest_path = MANIFEST_PATH
  if not manifest_path or manifest_path == "" then
    if FileDialog then
      local file_dialog = FileDialog()
      if file_dialog:FileOpen("txt", "", "Manifest Files (*.txt)|*.txt||") then
        manifest_path = file_dialog.PathName
      end
    end
  end
  if not manifest_path or manifest_path == "" then
    local why
    if not FileDialog then
      why = "Your VCarve version does not provide FileDialog(), so no\n"
        .. "file dialog is available. Set MANIFEST_PATH at the top of\n"
        .. "multi_layer_dxf.lua to the full path of your manifest.txt."
    else
      why = "No manifest file was picked. Run the gadget again and pick\n"
        .. "manifest.txt (next to the DXF from step_to_vcarve.py)."
    end
    DisplayMessageBox("multi_layer_dxf: could not pick a manifest file.\n\n" .. why)
    return false
  end
  local manifest_dir = manifest_path:match("^(.*[\\/])") or ""

  -- --- read manifest; comment lines carry the plan ---
  local dxf_name = nil
  local plan_summary = nil
  local plan_tools = {}   -- ordered list of tool tables from # tool lines
  local tabs_by_layer = {} -- layer -> {count, length_mm, thickness_mm}
  local lines = {}
  local fh = io.open(manifest_path, "r")
  if not fh then
    DisplayMessageBox("multi_layer_dxf: cannot open " .. manifest_path)
    return false
  end
  for line in fh:lines() do
    line = trim(line)
    if line:sub(1, 1) == "#" then
      dxf_name = dxf_name or line:match("^#%s*dxf:%s*(%S+)%s*$")
      local plan_txt = line:match("^#%s*plan:%s*(.+)$")
      if plan_txt then plan_summary = plan_txt end
      local tool_txt = line:match("^#%s*tool:%s*(.+)$")
      if tool_txt then
        local f = split(tool_txt, "|")
        table.insert(plan_tools, {
          id = trim(f[1] or ""), kind = trim(f[2] or "endmill"),
          dia_mm = tonumber(f[3]) or 0, tool_number = tonumber(f[4]) or 1,
          feed_mm_sec = tonumber(f[5]) or 30, plunge_mm_sec = tonumber(f[6]) or 10,
          spindle_rpm = tonumber(f[7]) or 20000,
          stepdown_mm = tonumber(f[8]) or 3.0, stepover_mm = tonumber(f[9]) or 0,
          name = "", -- filled below from id/kind/dia
        })
        local t = plan_tools[#plan_tools]
        if t.kind == "drill" then
          t.name = "Drill " .. dia_label(t.dia_mm)
        else
          t.name = "End Mill " .. dia_label(t.dia_mm)
        end
      end
      local tabs_txt = line:match("^#%s*tabs:%s*(.+)$")
      if tabs_txt then
        local f = split(tabs_txt, "|")
        tabs_by_layer[trim(f[1] or "")] = {
          count = tonumber(f[2]) or 4,
          length_mm = tonumber(f[3]) or 5.0,
          thickness_mm = tonumber(f[4]) or 1.0,
        }
      end
    elseif line ~= "" then
      table.insert(lines, line)
    end
  end
  fh:close()
  if #lines == 0 then
    DisplayMessageBox("multi_layer_dxf: manifest is empty: " .. manifest_path)
    return false
  end

  -- --- resolve tools for the plan (library matching / recommendation) ---
  local resolved, tool_warnings = resolve_tools(plan_tools)

  -- --- import DXF (full / preview mode) ---
  if MODE ~= "toolpaths_only" then
    local dxf_path = dxf_name and (manifest_dir .. dxf_name) or nil
    if not dxf_path then
      if FileDialog then
        local file_dialog = FileDialog()
        if file_dialog:FileOpen("dxf", "", "DXF Files (*.dxf)|*.dxf||") then
          dxf_path = file_dialog.PathName
        end
      end
    end
    if not dxf_path or dxf_path == "" then
      DisplayMessageBox("multi_layer_dxf: no DXF to import. The manifest has\n"
        .. "no '# dxf:' line and no DXF was picked.")
      return false
    end
    if not job:ImportDxfDwg(dxf_path) then
      DisplayMessageBox("multi_layer_dxf: DXF import failed for " .. dxf_path
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
    local tool_id = trim(parts[6] or "")
    local allowance_mm = tonumber(parts[7]) or 0
    local kind = trim(parts[8] or "")
    -- Rough and finish passes share one DXF layer but are two
    -- toolpaths: give them different names or VCarve shows two
    -- toolpaths with the same name.
    local tp_name = layer
    if kind == "rough" then tp_name = layer .. " rough" end
    if kind == "finish" then tp_name = layer .. " finish" end
    if layer == "" or operation == "" then
      DisplayMessageBox("multi_layer_dxf: bad manifest line: " .. line)
      return false
    end
    if operation_wanted(operation) and not layer_matches(SKIP_LAYERS, layer) then
      local layer_obj = job.LayerManager:FindLayerWithName(layer)
      if layer_obj == nil then
        DisplayMessageBox("multi_layer_dxf: no layer named " .. layer
          .. " in the job. Import the DXF first, or check the manifest.")
        return false
      end
      local selection = job.Selection
      selection:Clear()
      if not SelectVectorsOnLayer(layer_obj, selection, true, false, true) then
        DisplayMessageBox("multi_layer_dxf: no closed vectors on layer " .. layer)
        return false
      end
      -- No joining step: JoinVectors() does not exist in the V12 SDK,
      -- and DXF import already produces the closed contours that
      -- selection works on (a layer with none is reported above).
      -- Tool for this layer: the plan's resolved tool, or the v0.2
      -- fallback for old manifests.
      local tool_entry = resolved[tool_id]
      local tool = nil
      if tool_entry ~= nil then
        tool = tool_entry.tool
      else
        local fb, err = fallback_tool(operation, layer)
        if fb == nil then
          DisplayMessageBox("multi_layer_dxf: " .. tostring(err))
          return false
        end
        tool = fb
      end
      local ok, err
      if operation == "drill" then
        ok, err = create_drill(tp_name, layer, start_depth, cut_depth, tool, 2.0)
      elseif operation == "pocket" then
        ok, err = create_pocket(tp_name, layer, start_depth, cut_depth, tool, allowance_mm)
      elseif operation == "profile" then
        -- Place the tabs first: UseTabs alone creates none, so the
        -- profile toolpath would warn "No tabs defined" and cut
        -- without them (live test, Nov 22).
        local tabs = tabs_by_layer[layer]
        if tabs ~= nil then
          local placed = place_tabs_on_layer(layer_obj, tabs.count)
          if placed < tabs.count then
            table.insert(tool_warnings, layer .. ": placed " .. placed
              .. " of " .. tabs.count .. " tabs — the profile may cut"
              .. " with fewer tabs than planned")
          end
        end
        ok, err = create_profile(tp_name, layer, start_depth, cut_depth,
                                 tool, tabs_by_layer[layer])
      else
        DisplayMessageBox("multi_layer_dxf: unknown operation '" .. operation
          .. "' on layer " .. layer)
        return false
      end
      if not ok then
        DisplayMessageBox("multi_layer_dxf: failed on layer " .. layer
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

  local msg = "multi_layer_dxf: done — " .. created .. " toolpath(s) created"
    .. (skipped > 0 and (", " .. skipped .. " skipped") or "") .. "."
  if plan_summary then
    msg = msg .. "\nPlan: " .. plan_summary
  end
  if #plan_tools > 0 then
    msg = msg .. "\nTools used:"
    for _, t in ipairs(plan_tools) do
      local r = resolved[t.id]
      msg = msg .. "\n  T" .. (r and r.number or t.tool_number) .. ": "
        .. t.name .. " (" .. (r and r.source or "?") .. ")"
    end
  end
  for _, w in ipairs(tool_warnings) do
    msg = msg .. "\nWARNING: " .. w
  end
  msg = msg .. "\n\nPreview the toolpaths now. This gadget does not post\n"
    .. "G-code and does not save the job — File > Save As to save\n"
    .. "the .crv yourself, then post G-code with your post-processor."
  DisplayMessageBox(msg)
  return true
end
