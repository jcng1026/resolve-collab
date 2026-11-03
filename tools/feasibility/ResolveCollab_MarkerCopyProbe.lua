-- ResolveCollab M5 probe 2: media pool markers copied onto a clip whose frame
-- rate differs from the timeline's (SPEC §21.1).
--
-- Run from Workspace > Scripts > ResolveCollab_MarkerCopyProbe while
-- `node tools/feasibility/collect.ts --name m5-copy` is running.
--
-- Safety: every edit happens inside a new scratch project created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Found in the M5 two-PC test (2026-11-04): a 50 fps clip's pool marker,
-- copied onto a new item on a 24 fps timeline, sat between frames. GetMarkers
-- listed it at the frame below, where the per-frame calls couldn't find it.
-- Questions:
--   * Which copies land between frames, and what do the per-frame calls,
--     the exact in-between frame and DeleteMarkerByCustomData make of them?
--   * Does DeleteMarkersByColor("All") clear them, and do markers added back
--     on the listed frames keep their values and tags and answer by frame?
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

-- Each marker with what the per-frame calls make of it.
local function markers(owner)
  local out = {}
  for frame, m in pairs(owner:GetMarkers() or {}) do
    out[#out + 1] = { frame = frame, color = m.color, name = m.name, note = m.note, duration = m.duration, customData = m.customData,
      getAtFrame = try(function() return owner:GetMarkerCustomData(frame) end) }
  end
  table.sort(out, function(a, b) return a.frame < b.frame end)
  return out
end

local function main()
probe("ENV", "product", function() return R:GetProductName(), R:GetVersionString() end)
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab M5 Copy Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()
probe("COPY", "import", function() return #(mp:ImportMedia({ MEDIA .. "fps30.mp4", MEDIA .. "original.mp4" }) or {}) end)
local thirty, same = findClip(root, "fps30.mp4"), findClip(root, "original.mp4")
if not (thirty and same) then
  restore()
  finish("Test media could not be imported; stopped.")
  return
end

-- Pool markers: on the 30 fps clip at frames 7 (lands at 5.6 on 24 fps) and
-- 20 (16.0, a whole frame), one tagged; on the 24 fps clip at 9.
probe("COPY", "poolMarkers", function()
  return { a = thirty:AddMarker(7, "Cyan", "at 7", "note 7", 1, "rc:p:aaaa"), b = thirty:AddMarker(20, "Mint", "at 20", "", 3, ""),
    c = same:AddMarker(9, "Red", "at 9", "", 1, "rc:p:cccc"), fps30 = thirty:GetClipProperty("FPS"), fps24 = same:GetClipProperty("FPS"),
    pool30 = markers(thirty), pool24 = markers(same) }
end)

local tl = mp:CreateEmptyTimeline("RC Copy")
proj:SetCurrentTimeline(tl)
local base = tl:GetStartFrame()
mp:AppendToTimeline({ { mediaPoolItem = thirty, trackIndex = 1, recordFrame = base } })
mp:AppendToTimeline({ { mediaPoolItem = same, trackIndex = 1, recordFrame = base + 400 } })
local list = tl:GetItemListInTrack("video", 1) or {}
local A, B = list[1], list[2]
results.setup = { timelineFps = tl:GetSetting("timelineFrameRate"), a = A and A:GetName(), b = B and B:GetName() }

probe("COPY", "copiesOnItems", function()
  return { thirty = markers(A), same = markers(B), audio = markers((tl:GetItemListInTrack("audio", 1) or {})[1]) }
end)

-- The per-frame calls on the in-between copy, at its listed frame and at
-- its exact one (7 * 24 / 30 = 5.6).
probe("COPY", "perFrameCalls", function()
  local key
  for f in pairs(A:GetMarkers() or {}) do if not key or f < key then key = f end end
  return {
    key = key,
    getKey = try(function() return A:GetMarkerCustomData(key) end),
    updKey = try(function() return A:UpdateMarkerCustomData(key, "rc:x") end),
    getExact = try(function() return A:GetMarkerCustomData(5.6) end),
    updExact = try(function() return A:UpdateMarkerCustomData(5.6, "rc:x") end),
    byData = try(function() return A:GetMarkerByCustomData("rc:p:aaaa") end),
    after = markers(A),
  }
end)

-- Deleting an in-between copy, on a second use of the clip.
probe("COPY", "deleteAtKeyThenByData", function()
  local got = mp:AppendToTimeline({ { mediaPoolItem = thirty, trackIndex = 1, recordFrame = base + 800 } }) or {}
  local C = got[1]
  if not C then return "no second use" end
  local before = markers(C)
  local delKey = try(function() return C:DeleteMarkerAtFrame(5) end)
  local afterKey = markers(C)
  local delData = try(function() return C:DeleteMarkerByCustomData("rc:p:aaaa") end)
  return { before = before, delKey = delKey, afterKey = afterKey, delData = delData, afterData = markers(C) }
end)

-- The snap: clear by colour, add back on the listed frames with their tags.
probe("COPY", "snap", function()
  local before = markers(A)
  local cleared = A:DeleteMarkersByColor("All")
  local left = markers(A)
  local added = {}
  for _, m in ipairs(before) do
    added[#added + 1] = A:AddMarker(m.frame, m.color, m.name, m.note, m.duration, m.customData)
  end
  local after = markers(A)
  local tagged = {}
  for _, m in ipairs(after) do tagged[#tagged + 1] = A:UpdateMarkerCustomData(m.frame, "rc:snapped" .. m.frame) end
  return { before = before, cleared = cleared, left = left, added = added, after = after, tagged = tagged, final = markers(A) }
end)

probe("COPY", "deleteAfterSnap", function()
  local first
  for f in pairs(A:GetMarkers() or {}) do if not first or f < first then first = f end end
  return { frame = first, deleted = A:DeleteMarkerAtFrame(first), left = markers(A) }
end)

-- A marker added by a script on the 30 fps item lands on a whole frame.
probe("COPY", "scriptAddOn30", function()
  return { add = A:AddMarker(40, "Lemon", "script", "", 1, "rc:s"), list = markers(A) }
end)

probe("COPY", "saveScratch", function() return pm:SaveProject() end)
restore()
finish("Completed.")
end

local ok, err = pcall(main)
if not ok then
  results.fatal = tostring(err)
  pcall(restore)
  finish("Stopped by an unexpected error; the original project was reopened if possible.")
end
