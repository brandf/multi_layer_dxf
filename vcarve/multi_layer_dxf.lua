-- VECTRIC LUA SCRIPT
-- multi_layer_dxf.lua — VCarve Pro gadget (v0.4, implemented, NOT yet run in VCarve)
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
--      diameter, only the interactive dialog, so it asks once per tool;
--      Cancel uses the recommendation as-is, creating a tool with the
--      recommended diameter/feeds). Set MATCH_TO_LIBRARY = false to
--      skip the dialogs and always use the recommendations.
--      Tools get distinct numbers in first-use order (v0.2 made every
--      toolpath Tool 1, so the posted code called no tool change).
--   4. For each manifest line, in order (already drill -> pocket ->
--      profile, grouped by tool): select closed vectors on that layer,
--      join them, create the toolpath with start_depth / cut_depth
--      from the manifest and the resolved tool.
--        drill   -> CreateDrillingToolpath, peck if configured
--        pocket  -> CreatePocketingToolpath, raster clearance, profile last
--        profile -> CreateProfilingToolpath, PROFILE_OUTSIDE for the outer
--                   profile, PROFILE_ON for THROUGH_CUT slots (a closed
--                   loop cut on the line). BOTH get TABS from the # tabs
--                   line when one exists: the outer profile frees the
--                   part, a through cut frees the slug inside it (a
--                   doughnut hole's centre is a solid disc, not sawdust),
--                   and either goes flying without tabs.
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
--                             -- VCarve tool library (one dialog per tool)
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
--   SelectVectorsOnLayer(layer, selection, closed_only, open_only, ...)
--   Tool(name, Tool.END_MILL / Tool.THROUGH_DRILL), with .InMM,
--     .ToolDia, .Stepdown, .Stepover, .FeedRate, .PlungeRate,
--     .SpindleSpeed, .ToolNumber
--   ToolDatabase():SelectTool() — shows the Tool Database dialog,
--     returns the tool the user picks (or nil on Cancel). GetTool(id)
--     returns a tool by database id. There is NO search-by-diameter.
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
--   Written from the SDK docs above, syntax-checked with luaparser on
--   Linux, but NOT yet run inside VCarve — there is no VCarve on this
--   VM. Least-certain calls, all guarded so the gadget fails with a
--   message instead of silently doing the wrong thing:
--     GetFileName() — the file picker; if VCarve has no such global,
--       the gadget aborts with a message.
--     JoinVectors() — joining open vectors on a layer; if the global
--       does not exist, the gadget proceeds with the vectors as
--       imported and lets Create*Toolpath report the failure per layer.
--     ToolDatabase():SelectTool() — library matching; if the API is
--       missing or you Cancel, the gadget uses the recommendation.
--     ProfileParameterData.TabCount — not in the SDK mirror's property
--       list; set in a guarded call, VCarve's default applies if it
--       is ignored. Tab length/thickness ARE set from the manifest.
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
local MATCH_TO_LIBRARY = true -- pick each recommended tool from your
                              -- VCarve tool library (one dialog per tool);
                              -- Cancel uses the recommendation as-is

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

-- Resolve the plan's tools: match each recommendation to the VCarve
-- tool library when asked (one dialog per distinct tool), else create
-- a tool from the recommendation. Returns tool_id -> {tool=, source=,
-- dia_mm=, number=} and a list of warning strings.
local function resolve_tools(plan_tools)
  local resolved = {}
  local warnings = {}
  local use_dialog = MATCH_TO_LIBRARY and ToolDatabase ~= nil
  if use_dialog and #plan_tools > 0 then
    local summary = "multi_layer_dxf tool plan — pick the matching tool from "
      .. "your VCarve library for each recommendation below.\n"
      .. "Cancel on any tool uses the recommendation as-is.\n"
    for _, t in ipairs(plan_tools) do
      summary = summary .. "\nT" .. t.tool_number .. ": " .. t.name
        .. " — feed " .. t.feed_mm_sec .. " mm/s, plunge "
        .. t.plunge_mm_sec .. " mm/s, " .. t.spindle_rpm .. " rpm"
    end
    DisplayMessageBox(summary)
  end
  for _, t in ipairs(plan_tools) do
    local tool = nil
    local source = "recommendation"
    if use_dialog then
      local ok_db, db = pcall(function() return ToolDatabase() end)
      if ok_db and db ~= nil then
        local ok_pick, picked = pcall(function() return db:SelectTool() end)
        if ok_pick and picked ~= nil then
          tool = picked
          source = "your VCarve library"
          local ok_d, dia = pcall(function() return picked.ToolDia end)
          if ok_d and dia ~= nil and math.abs(dia - t.dia_mm) > 0.05 then
            table.insert(warnings, t.name .. ": you picked a "
              .. string.format("%.2f", dia) .. " mm tool instead of "
              .. string.format("%.2f", t.dia_mm)
              .. " mm — the cut will use the picked tool")
          end
          local ok_n, num = pcall(function() return picked.ToolNumber end)
          if ok_n and num ~= nil then t.tool_number = num end
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
    profile_data.UseTabs = true
    profile_data.TabLength = tabs.length_mm
    profile_data.TabThickness = tabs.thickness_mm
    profile_data.Use3dTabs = true
    -- TabCount is not in the SDK mirror's property list; try it
    -- guarded — VCarve's default applies if it is ignored.
    pcall(function() profile_data.TabCount = tabs.count end)
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

function main()
  local job = VectricJob()
  if not job.Exists then
    DisplayMessageBox("multi_layer_dxf: no job loaded. Create a job first, with\n"
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
    DisplayMessageBox("multi_layer_dxf: could not pick a manifest file.\n\n"
      .. "Pick manifest.txt (next to the DXF from step_to_vcarve.py)\n"
      .. "when the file dialog appears, or check that your VCarve\n"
      .. "version provides GetFileName().")
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
          t.name = "Drill " .. string.format("%.2f", t.dia_mm) .. " mm"
        else
          t.name = "End Mill " .. string.format("%.2f", t.dia_mm) .. " mm"
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
      if GetFileName then
        dxf_path = GetFileName("Select the layered DXF", "*.dxf")
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
      -- Join open vectors on this layer, if the SDK provides it.
      -- Our DXF loops are closed shapes made of separate line/arc
      -- entities, so joining is what makes them one closed vector.
      if JoinVectors then
        pcall(function() JoinVectors(selection, 0.01) end)
      end
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
