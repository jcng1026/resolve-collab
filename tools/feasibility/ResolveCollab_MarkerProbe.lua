-- ResolveCollab M5 probe: marker calls on this machine (SPEC §6.1).
--
-- Run from Workspace > Scripts > ResolveCollab_MarkerProbe while
-- `node tools/feasibility/collect.ts --name m5` is running.
--
-- Safety: every edit happens inside a new scratch project created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Questions:
--   * Timeline markers: which frames do AddMarker and GetMarkers count from?
--     What happens on an occupied frame, inside a long marker, beyond the end?
--   * Which colours and texts come back as given? Does customData identify a
--     marker, and can it be set on an existing one?
--   * Do markers on a timeline that isn't current, and on its items, work?
--   * Timeline item markers: which frames, shared with the media pool clip or
--     other uses of it, and what happens when the item moves or is trimmed?
--   * Do DuplicateTimeline copies keep customData? What does reading cost?
--   * Which markers persist after save + reopen?
-- Every API call used here is listed in docs/resolve-api/DaVinciResolveScript.pyi.

local STATE_DIR = [[__STATE_DIR__]]
local MEDIA = STATE_DIR .. "\\media\\"

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


-- All items of a timeline, every track type.
local function items(tl)
  local out = {}
  for _, kind in ipairs({ "video", "audio", "subtitle" }) do
    local n = tl:GetTrackCount(kind) or 0
    for i = 1, n do
      for _, it in ipairs(tl:GetItemListInTrack(kind, i) or {}) do out[#out + 1] = it end
    end
  end
  return out
end


local function timelineNames(proj)
  local out = {}
  for i = 1, proj:GetTimelineCount() or 0 do out[#out + 1] = proj:GetTimelineByIndex(i):GetName() end
  return out
end

local function findTimeline(proj, name)
  for i = 1, proj:GetTimelineCount() or 0 do
    local t = proj:GetTimelineByIndex(i)
    if t:GetName() == name then return t end
  end
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

-- Markers as a plain list, sorted by frame, for comparing.
local function markers(owner)
  local out = {}
  for frame, m in pairs(owner:GetMarkers() or {}) do
    out[#out + 1] = { frame = frame, color = m.color, name = m.name, note = m.note, duration = m.duration, customData = m.customData }
  end
  table.sort(out, function(a, b) return a.frame < b.frame end)
  return out
end

local function main()
probe("ENV", "product", function() return R:GetProductName(), R:GetVersionString() end)
local perSecond = probe("ENV", "gettimeUnitsPerSecond", function()
  local a = now(); bmd.wait(1); return now() - a
end) or 1
local function ms(units) return units / perSecond * 1000 end
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab M5 Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()

probe("M5", "import", function()
  return #(mp:ImportMedia({ MEDIA .. "original.mp4", MEDIA .. "spare.mp4" }) or {})
end)
local original, spare = findClip(root, "original.mp4"), findClip(root, "spare.mp4")
if not (original and spare) then
  restore()
  finish("Test media could not be imported; stopped.")
  return
end

local T1 = mp:CreateEmptyTimeline("RC M1")
local T2 = mp:CreateEmptyTimeline("RC M2")
if not (T1 and T2) then
  restore()
  finish("Timelines could not be created; stopped.")
  return
end
proj:SetCurrentTimeline(T1)
local base = T1:GetStartFrame()
-- original at 0 (240 frames), then spare from source frame 24 at 480.
mp:AppendToTimeline({ { mediaPoolItem = original, trackIndex = 1, recordFrame = base } })
mp:AppendToTimeline({ { mediaPoolItem = spare, startFrame = 24, endFrame = 119, trackIndex = 1, recordFrame = base + 480 } })
local A = (T1:GetItemListInTrack("video", 1) or {})[1]
local B = (T1:GetItemListInTrack("video", 1) or {})[2]
local Aaudio = (T1:GetItemListInTrack("audio", 1) or {})[1]
results.setup = { base = base, startTimecode = T1:GetStartTimecode(), a = A and A:GetStart(), b = B and B:GetStart(),
  bLeft = B and B:GetLeftOffset() }

-- Timeline markers --------------------------------------------------------------

probe("M5", "timelineAddFrames", function()
  return {
    rel10 = T1:AddMarker(10, "Blue", "M rel 10", "note 10", 1, "rc-t-10"),
    abs = T1:AddMarker(base + 20, "Green", "M abs", "", 1, ""),
    beyondEnd = T1:AddMarker(5000, "Red", "M beyond", "", 1),
    negative = T1:AddMarker(-5, "Red", "M negative", "", 1),
    sameFrame = T1:AddMarker(10, "Red", "M same frame", "", 1),
    long = T1:AddMarker(100, "Yellow", "M long", "", 48, "rc-t-100"),
    overlapLong = T1:AddMarker(120, "Pink", "M inside long", "", 1),
    list = markers(T1),
  }
end)
probe("M5", "timelineAllColours", function()
  local out = {}
  for i, c in ipairs({ "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream" }) do
    out[c] = T1:AddMarker(200 + i, c, c, "", 1)
  end
  out.bogus = T1:AddMarker(230, "Orange", "bogus", "", 1)
  return out
end)
probe("M5", "timelineText", function()
  local long = string.rep("x", 5000)
  local ok = T1:AddMarker(300, "Blue", "naïve 🎬 \"q\" \\ / \n line", "note é 🎬\nsecond line\ttab " .. long, 1, "cd é 🎬")
  local m = T1:GetMarkers()[300]
  return { ok = ok, name = m and m.name, noteLen = m and #m.note, noteHead = m and string.sub(m.note, 1, 40), customData = m and m.customData,
    byCustom = T1:GetMarkerByCustomData("cd é 🎬") }
end)
probe("M5", "timelineCustomData", function()
  local set = T1:UpdateMarkerCustomData(110, "rc-new")
  local setMissing = T1:UpdateMarkerCustomData(111, "rc-none")
  return { setOnLong = set, setWhereNone = setMissing, at100 = T1:GetMarkerCustomData(100), at110 = T1:GetMarkerCustomData(110),
    by = T1:GetMarkerByCustomData("rc-t-10"), byMissing = T1:GetMarkerByCustomData("nothing"), at10 = T1:GetMarkerCustomData(10) }
end)
probe("M5", "timelineDelete", function()
  local insideLong = T1:DeleteMarkerAtFrame(110)
  local byCd = T1:DeleteMarkerByCustomData("rc-t-10")
  local missing = T1:DeleteMarkerAtFrame(777)
  return { insideLong = insideLong, byCustomData = byCd, missing = missing, list = markers(T1) }
end)
probe("M5", "nonCurrentTimeline", function()
  -- T2 isn't current.
  local add = T2:AddMarker(5, "Blue", "on T2", "", 1, "rc-t2")
  local got = markers(T2)
  local upd = T2:UpdateMarkerCustomData(5, "rc-t2b")
  local del = T2:DeleteMarkerAtFrame(5)
  local add2 = T2:AddMarker(6, "Green", "T2 kept", "", 1, "rc-t2-keep")
  return { add = add, got = got, update = upd, delete = del, add2 = add2, after = markers(T2), current = proj:GetCurrentTimeline():GetName() }
end)

-- Timeline item and media pool clip markers ----------------------------------------

probe("M5", "itemMarkers", function()
  if not (A and B) then return "no items" end
  local a5 = A:AddMarker(5, "Blue", "A at 5", "", 1, "rc-i-a5")
  local b5 = B:AddMarker(5, "Red", "B at 5", "", 1, "rc-i-b5")
  local b0 = B:AddMarker(0, "Green", "B at 0", "", 1)
  local bSrc = B:AddMarker(24, "Pink", "B at 24", "", 1)
  local beyond = B:AddMarker(500, "Pink", "B beyond", "", 1)
  return { a5 = a5, b5 = b5, b0 = b0, b24 = bSrc, beyond = beyond, A = markers(A), B = markers(B),
    audio = Aaudio and markers(Aaudio), poolOriginal = markers(original), poolSpare = markers(spare), timeline = markers(T1) }
end)
probe("M5", "poolMarkers", function()
  local p = original:AddMarker(50, "Cyan", "pool at 50", "", 1, "rc-p-50")
  local p2 = spare:AddMarker(30, "Mint", "pool spare at 30", "", 1)
  return { add = p, add2 = p2, pool = markers(original), poolSpare = markers(spare), itemA = markers(A), itemB = markers(B), timeline = markers(T1) }
end)
probe("M5", "itemMovedAndTrimmed", function()
  local moved = B:SetPosition({ startFrame = base + 600 })
  local afterMove = markers(B)
  local trimmed = B:SetLeftOffset((B:GetLeftOffset() or 0) + 10)
  return { moved = moved, afterMove = afterMove, trimmed = trimmed, left = B:GetLeftOffset(), afterTrim = markers(B), start = B:GetStart() - base }
end)
probe("M5", "secondUseOfClip", function()
  -- The same media pool clip used again: does it share item markers?
  local got = mp:AppendToTimeline({ { mediaPoolItem = original, trackIndex = 1, recordFrame = base + 900 } }) or {}
  local C = got[1]
  return { appended = #got, C = C and markers(C), A = markers(A), pool = markers(original) }
end)
probe("M5", "itemOnNonCurrent", function()
  proj:SetCurrentTimeline(T2)
  mp:AppendToTimeline({ { mediaPoolItem = spare, trackIndex = 1, recordFrame = T2:GetStartFrame() } })
  local it = (T2:GetItemListInTrack("video", 1) or {})[1]
  proj:SetCurrentTimeline(T1)
  if not it then return "no item on T2" end
  local add = it:AddMarker(3, "Blue", "item on T2", "", 1, "rc-i-t2")
  local list = markers(it)
  local del = it:DeleteMarkerAtFrame(3)
  local add2 = it:AddMarker(4, "Lemon", "item on T2 kept", "", 1, "rc-i-t2-keep")
  return { add = add, got = list, delete = del, add2 = add2, after = markers(it), current = proj:GetCurrentTimeline():GetName() }
end)

-- Copies --------------------------------------------------------------------------------

probe("M5", "duplicateTimeline", function()
  local dup = T1:DuplicateTimeline("RC M1 copy")
  proj:SetCurrentTimeline(T1)
  if not dup then return "no duplicate" end
  local dA = (dup:GetItemListInTrack("video", 1) or {})[1]
  return { timeline = markers(dup), itemA = dA and markers(dA), current = proj:GetCurrentTimeline():GetName() }
end)

-- Cost ----------------------------------------------------------------------------------

probe("M5", "readCost", function()
  for i = 1, 100 do T1:AddMarker(1000 + i * 2, "Sky", "cost " .. i, "", 1, "rc-cost-" .. i) end
  local t0 = now()
  for _ = 1, 20 do T1:GetMarkers() end
  local tl100 = ms((now() - t0) / 20)
  t0 = now()
  for _ = 1, 20 do A:GetMarkers() end
  local item = ms((now() - t0) / 20)
  t0 = now()
  for _ = 1, 20 do original:GetMarkers() end
  local pool = ms((now() - t0) / 20)
  return { timeline100Ms = tl100, itemMs = item, poolMs = pool }
end)

-- Persistence: save, reopen ---------------------------------------------------------------

results.persist.before = { t1 = markers(T1), t2 = markers(T2), a = markers(A), b = markers(B), pool = markers(original) }
probe("M5", "saveScratch", function() return pm:SaveProject() end)
restore()
local reopened = probe("M5", "reopenScratch", function() return pm:LoadProject(scratchName) end)
if reopened then
  local t1 = findTimeline(reopened, "RC M1")
  local t2 = findTimeline(reopened, "RC M2")
  local list = t1 and (t1:GetItemListInTrack("video", 1) or {}) or {}
  local pool = findClip(reopened:GetMediaPool():GetRootFolder(), "original.mp4")
  results.persist.reopened = { t1 = t1 and markers(t1), t2 = t2 and markers(t2), a = list[1] and markers(list[1]),
    b = list[2] and markers(list[2]), pool = pool and markers(pool) }
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
