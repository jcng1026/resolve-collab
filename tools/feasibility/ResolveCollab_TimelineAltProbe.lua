-- ResolveCollab M4 follow-up probe: alternatives for what the first timeline
-- probe found missing on Free (see findings, "M4 timeline probe").
--
-- Run from Workspace > Scripts > ResolveCollab_TimelineAltProbe while
-- `node tools/feasibility/collect.ts --name m4-alt` is running.
--
-- Safety: every edit happens inside a new scratch project created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Questions:
--   * Fades: does a Cross Dissolve at a clip's head/tail (fade from/to black)
--     work and persist? Do API fades survive a .drt round trip?
--   * Titles: can a basic Text title's text be read or set through undocumented
--     properties? Can a Text+ title's text be read and set through its Fusion
--     comp, and does that persist? Does an In/Out mark set the length of an
--     inserted title or generator? Can a Text+ title be made longer?
--   * ImportIntoTimeline (AAF): where do items land in an existing timeline,
--     and do fades and Text+ text come along? Does it work on a timeline that
--     isn't current?
--   * Enable/disable on a timeline that isn't current through SetProperty.
-- Every API call used here is listed in docs/resolve-api/DaVinciResolveScript.pyi.

local STATE_DIR = [[__STATE_DIR__]]
local MEDIA = STATE_DIR .. "\\media\\"
local OUT = STATE_DIR .. "\\out\\"

local F = fusion or fu or app
local results = { probes = {}, persist = {} }

-- Encoding and reporting (same format as ResolveCollab_Feasibility.lua) ------

local function plain(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "nil" or t == "boolean" or t == "number" or t == "string" then return v end
  if t == "table" then
    if depth >= 5 then return "<table>" end
    local out, n = {}, 0
    for k, x in pairs(v) do
      n = n + 1
      if n > 400 then out["<truncated>"] = true break end
      out[tostring(k)] = plain(x, depth + 1)
    end
    return out
  end
  return "<" .. t .. ">"
end

local function jstr(s)
  return '"' .. (s:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end)) .. '"'
end

local function json(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.17g", v)
  end
  if t == "string" then return jstr(v) end
  if t == "table" then
    local parts = {}
    for k, x in pairs(v) do parts[#parts + 1] = jstr(tostring(k)) .. ":" .. json(x) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return jstr("<" .. t .. ">")
end

local function hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

local CHUNK = 1500

local function emitRaw(key, payload)
  if not F then return false end
  F:Execute('error("RCFEAS|' .. key .. '|' .. payload .. '")')
  return true
end

local function put(key, text) return emitRaw(key, hex(text)) end

local function now() return bmd.gettime() end

local function probe(id, label, fn)
  put("Stage", label)
  local t0 = now()
  local ok, a, b = pcall(fn)
  local entry = { id = id, label = label, ok = ok, dt = now() - t0 }
  if ok then entry.value = plain(a); entry.extra = plain(b) else entry.error = tostring(a) end
  results.probes[#results.probes + 1] = entry
  if ok then return a, b end
end

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return plain(v) end
  return { error = tostring(v) }
end

local function finish(note)
  results.note = note
  local h = hex(json(results))
  local n = 0
  for i = 1, #h, CHUNK do
    n = n + 1
    emitRaw("Result" .. n, string.sub(h, i, i + CHUNK - 1))
  end
  put("ResultCount", tostring(n))
  put("Stage", "done")
end

-- Timeline helpers -------------------------------------------------------------

local function findClip(folder, name)
  for _, c in ipairs(folder:GetClipList() or {}) do
    if c:GetName() == name then return c end
  end
end

local function itemRecord(it)
  return {
    id = try(function() return it:GetUniqueId() end),
    type = try(function() return it:GetType() end),
    name = try(function() return it:GetName() end),
    media = try(function() local m = it:GetMediaPoolItem(); return m and m:GetName() or nil end),
    track = try(function() local k, i = it:GetTrackTypeAndIndex(); return k end),
    start = try(function() return it:GetStart() end),
    ["end"] = try(function() return it:GetEnd() end),
    left = try(function() return it:GetLeftOffset() end),
    right = try(function() return it:GetRightOffset() end),
    fades = try(function() return it:GetFades() end),
    comps = try(function() return it:GetFusionCompCount() end),
  }
end

local function items(tl)
  local out = {}
  for _, kind in ipairs({ "video", "audio" }) do
    for i = 1, tl:GetTrackCount(kind) or 0 do
      for _, it in ipairs(tl:GetItemListInTrack(kind, i) or {}) do out[#out + 1] = it end
    end
  end
  return out
end

local function records(tl)
  local out = {}
  for _, it in ipairs(items(tl)) do out[#out + 1] = itemRecord(it) end
  return out
end

local function findTimeline(proj, name)
  for i = 1, proj:GetTimelineCount() or 0 do
    local t = proj:GetTimelineByIndex(i)
    if t:GetName() == name then return t end
  end
end

local function findItem(tl, pred)
  for _, it in ipairs(items(tl)) do if pred(it) then return it end end
end

-- Timecode for a frame offset from the timeline start (24 fps, 01:00:00:00 start).
local function tcAt(offset)
  local fps = 24
  return string.format("01:%02d:%02d:%02d", math.floor(offset / fps / 60), math.floor(offset / fps) % 60, offset % fps)
end

-- Text of the first Text+ tool in an item's first Fusion comp.
local function textPlus(it)
  local comp = it:GetFusionCompByIndex(1)
  if not comp then return { comp = false } end
  local tools = comp:GetToolList(false, "TextPlus") or {}
  local tool = tools[1]
  if not tool then return { comp = true, tool = false } end
  return { comp = true, tool = true, text = try(function() return tool:GetInput("StyledText") end),
    text0 = try(function() return tool:GetInput("StyledText", 0) end),
    font = try(function() return tool:GetInput("Font") end), size = try(function() return tool:GetInput("Size") end) }
end

-- Start ----------------------------------------------------------------------

put("Stage", "started")
local R = resolve
if not R then
  put("Fatal", "no resolve global")
  put("Stage", "done")
  return
end
F = F or R:Fusion()

local pm = R:GetProjectManager()
local orig = pm:GetCurrentProject()
local origName = orig and orig:GetName()

local function restore()
  if origName then probe("SAFE", "reopenOriginal", function() return pm:LoadProject(origName) ~= nil end) end
end

local function main()
probe("ENV", "product", function() return R:GetProductName(), R:GetVersionString() end)
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab M4 Alt Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()
mp:ImportMedia({ MEDIA .. "original.mp4", MEDIA .. "spare.mp4", MEDIA .. "alt.mp4" })
local original, spare, alt = findClip(root, "original.mp4"), findClip(root, "spare.mp4"), findClip(root, "alt.mp4")
if not (original and spare and alt) then
  restore()
  finish("Test media could not be imported; stopped.")
  return
end

local A = mp:CreateEmptyTimeline("RC Alt")
proj:SetCurrentTimeline(A)
local base = A:GetStartFrame()
A:AddTrack("video")
mp:AppendToTimeline({ { mediaPoolItem = spare, mediaType = 1, trackIndex = 1, recordFrame = base } })
mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 1, recordFrame = base + 480 } })
mp:AppendToTimeline({ { mediaPoolItem = original, mediaType = 1, trackIndex = 1, recordFrame = base + 960 } })
local spareItem = findItem(A, function(it) return it:GetName() == "spare.mp4" end)
local altItem = findItem(A, function(it) return it:GetName() == "alt.mp4" end)
local origItem = findItem(A, function(it) return it:GetName() == "original.mp4" end)

-- Fades ------------------------------------------------------------------------

probe("ALT", "fadeViaTransitions", function()
  local out = {}
  for _, align in ipairs({ "right", "center", "left" }) do
    local r = try(function()
      return spareItem:AddTransition({ type = "Cross Dissolve", category = "simple", position = "start", alignment = align, duration = 12 })
    end)
    out["head_" .. align] = r
    if r and r ~= false and type(r) ~= "table" then break end
  end
  for _, align in ipairs({ "left", "center", "right" }) do
    local r = try(function()
      return spareItem:AddTransition({ type = "Cross Dissolve", category = "simple", position = "end", alignment = align, duration = 12 })
    end)
    out["tail_" .. align] = r
    if r and r ~= false and type(r) ~= "table" then break end
  end
  out.after = records(A)
  return out
end)
probe("ALT", "fadesThroughDrt", function()
  local set = altItem:SetFades({ FadeIn = 10, FadeOut = 14 })
  local drt = OUT .. "m4-alt-fades.drt"
  local exported = A:Export(drt, R.EXPORT_DRT, R.EXPORT_NONE)
  local imported = mp:ImportTimelineFromFile(drt, { importSourceClips = false })
  local copy = imported and findItem(imported, function(it) return it:GetName() == "alt.mp4" end)
  local name = imported and imported:GetName()
  proj:SetCurrentTimeline(A)
  return { set = set, read = altItem:GetFades(), exported = exported, importedName = name,
    copyFades = copy and copy:GetFades() }
end)

-- Titles ------------------------------------------------------------------------

local function insertPastEnd(insert)
  local offset = A:GetEndFrame() - base + 48
  A:SetCurrentTimecode(tcAt(offset))
  return insert()
end

probe("ALT", "basicTitleProperties", function()
  local title = insertPastEnd(function() return A:InsertTitleIntoTimeline("Text") end)
  if not title then return "no title" end
  local keys = {}
  for k, v in pairs(title:GetProperties() or {}) do keys[tostring(k)] = plain(v) end
  local guesses = {}
  for _, k in ipairs({ "Text", "StyledText", "Title", "RichText", "TextContent", "Font", "Size", "Color" }) do
    guesses[k] = try(function() return title:GetProperty(k) end)
  end
  local sets = {}
  for _, k in ipairs({ "Text", "StyledText", "RichText" }) do
    sets[k] = try(function() return title:SetProperty(k, "RC title text") end)
  end
  title:SetPosition({ startFrame = base + 300, trackIndex = 2 })
  return { record = itemRecord(title), properties = keys, guesses = guesses, sets = sets,
    afterSets = try(function() return title:GetProperty("Text") end) }
end)
probe("ALT", "textPlusTextViaFusion", function()
  local plus = insertPastEnd(function() return A:InsertFusionTitleIntoTimeline("Text+") end)
  if not plus then return "no Text+" end
  local before = textPlus(plus)
  local comp = plus:GetFusionCompByIndex(1)
  local tool = comp and (comp:GetToolList(false, "TextPlus") or {})[1]
  local set = tool and try(function()
    comp:Lock()
    tool:SetInput("StyledText", "RC Text+ ü 1")
    tool:SetInput("Size", 0.12)
    comp:Unlock()
    return true
  end)
  plus:SetPosition({ startFrame = base + 700, trackIndex = 2 })
  return { record = itemRecord(plus), before = before, set = set, after = textPlus(plus) }
end)
probe("ALT", "textPlusLonger", function()
  local plus = findItem(A, function(it) return it:GetName() == "Text+" end)
  if not plus then return "no Text+" end
  local before = itemRecord(plus)
  local right = try(function() return plus:SetRightOffset(-60) end)
  local afterRight = itemRecord(plus)
  local left = try(function() return plus:SetLeftOffset(-24) end)
  return { before = before, setRightNegative = right, afterRight = afterRight, setLeftNegative = left, after = itemRecord(plus) }
end)
probe("ALT", "lengthFromInOutMarks", function()
  local out = {}
  local offset = A:GetEndFrame() - base + 48
  for _, mode in ipairs({ "relative", "absolute" }) do
    local markIn = mode == "relative" and offset or base + offset
    local set = A:SetMarkInOut(markIn, markIn + 59)
    local marks = A:GetMarkInOut()
    A:SetCurrentTimecode(tcAt(offset))
    local title = A:InsertTitleIntoTimeline("Text")
    out[mode] = { set = set, marks = marks, title = title and itemRecord(title) }
    A:ClearMarkInOut()
    if title then
      title:SetPosition({ startFrame = base + 1400 + (mode == "relative" and 0 or 200), trackIndex = 2 })
    end
    offset = A:GetEndFrame() - base + 48
  end
  local markIn = A:GetEndFrame() - base + 48
  A:SetMarkInOut(markIn, markIn + 35)
  A:SetCurrentTimecode(tcAt(markIn))
  local gen = A:InsertGeneratorIntoTimeline("Solid Color")
  out.generatorRelative = { marks = A:GetMarkInOut(), gen = gen and itemRecord(gen) }
  A:ClearMarkInOut()
  if gen then gen:SetPosition({ startFrame = base + 1800, trackIndex = 2 }) end
  return out
end)

-- ImportIntoTimeline (AAF) -------------------------------------------------------

probe("ALT", "aafIntoExistingTimeline", function()
  local S = mp:CreateEmptyTimeline("RC Alt Source")
  proj:SetCurrentTimeline(S)
  local sb = S:GetStartFrame()
  mp:AppendToTimeline({ { mediaPoolItem = original, mediaType = 1, trackIndex = 1, recordFrame = sb + 2400 } })
  local src = findItem(S, function(it) return it:GetName() == "original.mp4" end)
  if src then src:SetFades({ FadeIn = 8, FadeOut = 8 }) end
  S:SetCurrentTimecode(tcAt(2400 + 240 + 24))
  local plus = S:InsertFusionTitleIntoTimeline("Text+")
  if plus then
    local comp = plus:GetFusionCompByIndex(1)
    local tool = comp and (comp:GetToolList(false, "TextPlus") or {})[1]
    if tool then tool:SetInput("StyledText", "RC from AAF") end
  end
  local aaf = OUT .. "m4-alt.aaf"
  local exported = S:Export(aaf, R.EXPORT_AAF, R.EXPORT_AAF_NEW)
  local source = records(S)
  -- into A while A is current
  proj:SetCurrentTimeline(A)
  local beforeA = #items(A)
  local intoCurrent = try(function() return A:ImportIntoTimeline(aaf, { autoImportSourceClipsIntoMediaPool = false }) end)
  local afterA = records(A)
  -- into another timeline while A stays current
  local B = mp:CreateEmptyTimeline("RC Alt Target")
  proj:SetCurrentTimeline(A)
  local intoOther = try(function() return B:ImportIntoTimeline(aaf, { autoImportSourceClipsIntoMediaPool = false }) end)
  local plusInA = findItem(A, function(it) return it:GetName() == "Text+" and it:GetStart() > base + 2400 end)
  return { exported = exported, source = source, beforeA = beforeA, intoCurrent = intoCurrent, afterA = afterA,
    currentAfter = proj:GetCurrentTimeline():GetName(), intoOther = intoOther, otherItems = records(B),
    importedTextPlus = plusInA and textPlus(plusInA), poolCount = #(root:GetClipList() or {}) }
end)

-- Enable on a timeline that isn't current ---------------------------------------

probe("ALT", "enableOnOtherTimeline", function()
  local C = mp:CreateEmptyTimeline("RC Alt Other")
  proj:SetCurrentTimeline(C)
  mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 1 } })
  proj:SetCurrentTimeline(A)
  local it = (C:GetItemListInTrack("video", 1) or {})[1]
  if not it then return "no item" end
  local out = { setClipEnabled = try(function() return it:SetClipEnabled(false) end), after1 = try(function() return it:GetClipEnabled() end) }
  for _, k in ipairs({ "ClipEnabled", "Enabled", "VideoEnabled" }) do
    out["set_" .. k] = try(function() return it:SetProperty(k, false) end)
    out["get_" .. k] = try(function() return it:GetProperty(k) end)
  end
  out.final = try(function() return it:GetClipEnabled() end)
  out.deleteRipple = try(function() return C:DeleteClips({ it }, true) end)
  out.left = #(C:GetItemListInTrack("video", 1) or {})
  return out
end)

-- Persistence -------------------------------------------------------------------

results.persist.before = { a = records(A) }
probe("ALT", "saveScratch", function() return pm:SaveProject() end)
restore()
local reopened = probe("ALT", "reopenScratch", function() return pm:LoadProject(scratchName) end)
if reopened then
  local a = findTimeline(reopened, "RC Alt")
  local texts = {}
  if a then
    for _, it in ipairs(items(a)) do
      if it:GetName() == "Text+" then texts[#texts + 1] = { start = it:GetStart(), text = textPlus(it) } end
    end
  end
  local copies = {}
  for i = 1, reopened:GetTimelineCount() or 0 do
    local t = reopened:GetTimelineByIndex(i)
    local x = findItem(t, function(it) return it:GetName() == "alt.mp4" end)
    copies[t:GetName()] = x and x:GetFades()
  end
  results.persist.reopened = { a = a and records(a), textPlus = texts, altFadesByTimeline = copies }
end
restore()

finish("Completed.")
end

local ok, err = pcall(main)
if not ok then
  results.fatal = tostring(err)
  pcall(restore)
  finish("Stopped by an unexpected error; the original project was reopened if possible.")
end
