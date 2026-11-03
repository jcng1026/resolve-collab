-- ResolveCollab M4 probe: timeline calls on this machine (SPEC §6.1, §3.4, §3.5).
--
-- Run from Workspace > Scripts > ResolveCollab_TimelineProbe while
-- `node tools/feasibility/collect.ts --name m4` is running.
--
-- Safety: every edit happens inside new scratch projects created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Questions (M1 already showed trims, moves, properties, enable, speed and
-- DuplicateTimeline work on Free):
--   * Do timeline item IDs survive save + reopen, DuplicateTimeline and .drt?
--     Can a timeline carry a collab ID through its media pool item?
--   * AppendToTimeline only targets the current timeline: what does switching
--     away and back cost, and does it keep the user's playhead?
--   * Can items on a timeline that isn't current be edited directly?
--   * Where does an append land: linked audio, source ranges, overlaps?
--   * Items without media files: titles, generators, compound clips; transitions.
--   * Track and timeline operations; which edits persist after save + reopen.
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

-- Everything ResolveCollab would snapshot about a timeline item.
local function itemRecord(it)
  local mpi = try(function() local m = it:GetMediaPoolItem(); return m and m:GetName() or nil end)
  local linked = try(function()
    local out = {}
    for _, l in ipairs(it:GetLinkedItems() or {}) do out[#out + 1] = l:GetUniqueId() end
    return out
  end)
  return {
    id = try(function() return it:GetUniqueId() end),
    type = try(function() return it:GetType() end),
    name = try(function() return it:GetName() end),
    media = mpi,
    track = try(function() return it:GetTrackTypeAndIndex() end),
    start = try(function() return it:GetStart() end),
    ["end"] = try(function() return it:GetEnd() end),
    left = try(function() return it:GetLeftOffset() end),
    right = try(function() return it:GetRightOffset() end),
    srcStart = try(function() return it:GetSourceStartFrame() end),
    srcEnd = try(function() return it:GetSourceEndFrame() end),
    enabled = try(function() return it:GetClipEnabled() end),
    color = try(function() return it:GetClipColor() end),
    speed = try(function() return it:GetSpeed() end),
    fades = try(function() return it:GetFades() end),
    zoomX = try(function() return it:GetProperty("ZoomX") end),
    opacity = try(function() return it:GetProperty("Opacity") end),
    transition = try(function() return it:GetProperty("TransitionType") end),
    linked = linked,
  }
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

local function records(tl)
  local out = {}
  for _, it in ipairs(items(tl)) do out[#out + 1] = itemRecord(it) end
  return out
end

local function trackList(tl)
  local out = {}
  for _, kind in ipairs({ "video", "audio", "subtitle" }) do
    for i = 1, tl:GetTrackCount(kind) or 0 do
      out[#out + 1] = { kind = kind, index = i, name = try(function() return tl:GetTrackName(kind, i) end),
        enabled = try(function() return tl:GetIsTrackEnabled(kind, i) end),
        locked = try(function() return tl:GetIsTrackLocked(kind, i) end),
        subType = try(function() return tl:GetTrackSubType(kind, i) end),
        count = #(tl:GetItemListInTrack(kind, i) or {}) }
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

local function main()
probe("ENV", "product", function() return R:GetProductName(), R:GetVersionString() end)
local perSecond = probe("ENV", "gettimeUnitsPerSecond", function()
  local a = now(); bmd.wait(1); return now() - a
end) or 1
local function ms(units) return units / perSecond * 1000 end
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab M4 Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()

probe("M4", "import", function()
  return #(mp:ImportMedia({ MEDIA .. "original.mp4", MEDIA .. "spare.mp4", MEDIA .. "alt.mp4" }) or {})
end)
local original, spare, alt = findClip(root, "original.mp4"), findClip(root, "spare.mp4"), findClip(root, "alt.mp4")
if not (original and spare and alt) then
  restore()
  finish("Test media could not be imported; stopped.")
  return
end

-- Timelines and their identity -----------------------------------------------

local T1 = probe("M4", "createTimelines", function()
  local a = mp:CreateEmptyTimeline("RC T1")
  local b = mp:CreateEmptyTimeline("RC T2")
  local dupName = mp:CreateEmptyTimeline("RC T1")
  return a, { t2 = b ~= nil, duplicateNameAccepted = dupName ~= nil }
end)
local T2 = findTimeline(proj, "RC T2")
if not (T1 and T2) then
  restore()
  finish("Timelines could not be created; stopped.")
  return
end
proj:SetCurrentTimeline(T1)
local base = T1:GetStartFrame()

probe("M4", "timelineIdentity", function()
  local mpi = T1:GetMediaPoolItem()
  local set = mpi and mpi:SetThirdPartyMetadata({ rcId = "t-0001" })
  return { id = T1:GetUniqueId(), startFrame = base, startTimecode = T1:GetStartTimecode(),
    poolItem = mpi ~= nil, poolItemType = mpi and mpi:GetClipProperty("Type"), setRcId = set,
    rcId = mpi and mpi:GetThirdPartyMetadata("rcId"), names = timelineNames(proj) }
end)
probe("M4", "timelineSettingsKeys", function()
  local s = T1:GetSettings() or {}
  return { count = (function() local n = 0 for _ in pairs(s) do n = n + 1 end return n end)(),
    useCustom = s.useCustomSettings, fps = s.timelineFrameRate, width = s.timelineResolutionWidth,
    height = s.timelineResolutionHeight }
end)

-- Appending: linked audio, source range, record frame, overlaps ---------------

local playheadBefore = T1:GetCurrentTimecode()
probe("M4", "appendFull", function()
  local got = mp:AppendToTimeline({ { mediaPoolItem = original, trackIndex = 1, recordFrame = base } }) or {}
  local out = {}
  for _, it in ipairs(got) do out[#out + 1] = itemRecord(it) end
  return { returned = #got, items = out, playheadBefore = playheadBefore, playheadAfter = T1:GetCurrentTimecode() }
end)
probe("M4", "appendVideoOnlyWithRange", function()
  local got = mp:AppendToTimeline({ { mediaPoolItem = spare, startFrame = 24, endFrame = 71, mediaType = 1,
    trackIndex = 1, recordFrame = base + 480 } }) or {}
  local out = {}
  for _, it in ipairs(got) do out[#out + 1] = itemRecord(it) end
  return { returned = #got, items = out }
end)
probe("M4", "appendAudioOnlyTrack2", function()
  local added = T1:AddTrack("audio", "stereo")
  local got = mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 2, trackIndex = 2, recordFrame = base + 48 } }) or {}
  local out = {}
  for _, it in ipairs(got) do out[#out + 1] = itemRecord(it) end
  return { addTrack = added, returned = #got, items = out, tracks = trackList(T1) }
end)
probe("M4", "appendOverExistingClip", function()
  local before = records(T1)
  local got = mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 1, recordFrame = base + 120 } }) or {}
  return { returned = #got, before = #before, after = records(T1) }
end)
probe("M4", "appendSecondVideoTrack", function()
  local added = T1:AddTrack("video")
  local got = mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 2, recordFrame = base + 600 } }) or {}
  return { addTrack = added, returned = #got, tracks = trackList(T1) }
end)

-- Editing a timeline that isn't current ---------------------------------------

probe("M4", "switchAppendSwitchBack", function()
  T1:SetCurrentTimecode("01:00:05:00")
  local tc = T1:GetCurrentTimecode()
  local t0 = now()
  local sw = proj:SetCurrentTimeline(T2)
  local got = mp:AppendToTimeline({ { mediaPoolItem = spare, trackIndex = 1, recordFrame = T2:GetStartFrame() } }) or {}
  local back = proj:SetCurrentTimeline(T1)
  local dt = now() - t0
  return { switched = sw, appended = #got, back = back, totalMs = ms(dt), playheadBefore = tc,
    playheadAfter = T1:GetCurrentTimecode(), current = proj:GetCurrentTimeline():GetName(), t2Items = #items(T2) }
end)
probe("M4", "editNonCurrentTimeline", function()
  local list = T2:GetItemListInTrack("video", 1) or {}
  local it = list[1]
  if not it then return "no item on T2" end
  local r = {
    trimLeft = try(function() return it:SetLeftOffset(12) end),
    move = try(function() return it:SetPosition({ startFrame = T2:GetStartFrame() + 100 }) end),
    props = try(function() return it:SetProperties({ ZoomX = 1.25, ZoomY = 1.25 }) end),
    enable = try(function() return it:SetClipEnabled(false) end),
    color = try(function() return it:SetClipColor("Pink") end),
    name = try(function() return it:SetName("renamed on T2") end),
  }
  r.after = itemRecord(it)
  r.current = proj:GetCurrentTimeline():GetName()
  r.deleteOther = try(function()
    local second = mp:CreateEmptyTimeline("RC T3")
    proj:SetCurrentTimeline(second)
    mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 1 } })
    proj:SetCurrentTimeline(T1)
    local x = (second:GetItemListInTrack("video", 1) or {})[1]
    return { deleted = x and second:DeleteClips({ x }, false), left = #(second:GetItemListInTrack("video", 1) or {}) }
  end)
  return r
end)

-- Trims, moves, properties on the current timeline ----------------------------

local first = (T1:GetItemListInTrack("video", 1) or {})[1]
probe("M4", "trimWithLinkedAudio", function()
  local beforeV = itemRecord(first)
  local l = first:SetLeftOffset((first:GetLeftOffset() or 0) + 12)
  local r = first:SetRightOffset((first:GetRightOffset() or 0) + 24)
  return { setLeft = l, setRight = r, before = beforeV, after = itemRecord(first), all = records(T1) }
end)
probe("M4", "moveWithSetPosition", function()
  local ok1 = first:SetPosition({ startFrame = base + 1000 })
  local afterFrame = itemRecord(first)
  local ok2 = first:SetPosition({ trackIndex = 2 })
  return { frame = ok1, afterFrame = afterFrame, track = ok2, afterTrack = itemRecord(first), all = records(T1) }
end)
probe("M4", "moveOntoOccupied", function()
  local v1 = T1:GetItemListInTrack("video", 1) or {}
  local target = v1[1]
  if not target then return "no item on V1" end
  local ok = first:SetPosition({ trackIndex = 1, startFrame = target:GetStart() })
  return { moved = ok, all = records(T1) }
end)
probe("M4", "propertiesSpeedFadesEnabled", function()
  -- the overlap move above may have removed `first`, so take what's on V1 now
  local it = (T1:GetItemListInTrack("video", 1) or {})[1]
  if not it then return "no item on V1" end
  return {
    props = it:SetProperties({ ZoomX = 1.5, ZoomY = 1.5, Opacity = 60, Pan = 100 }),
    speed = try(function() return it:SetSpeed({ Percentage = 50 }) end),
    fades = try(function() return it:SetFades({ FadeIn = 6, FadeOut = 6 }) end),
    enabled = it:SetClipEnabled(false),
    color = it:SetClipColor("Orange"),
    name = try(function() return it:SetName("item renamed") end),
    keys = (function() local k = {} for key in pairs(it:GetProperties() or {}) do k[#k + 1] = key end table.sort(k) return k end)(),
    after = itemRecord(it),
  }
end)
probe("M4", "linkUnlink", function()
  local v = (T1:GetItemListInTrack("video", 1) or {})
  local a = (T1:GetItemListInTrack("audio", 1) or {})
  if not (v[1] and a[1]) then return "need V1 and A1 items" end
  local un = T1:SetClipsLinked({ v[1], a[1] }, false)
  local linkedAfterUnlink = #(v[1]:GetLinkedItems() or {})
  local re = T1:SetClipsLinked({ v[1], a[1] }, true)
  return { unlink = un, linkedAfterUnlink = linkedAfterUnlink, relink = re, linkedAfterRelink = #(v[1]:GetLinkedItems() or {}) }
end)

-- Items without a media file, transitions, compound clips ---------------------

probe("M4", "insertTitleAndGenerators", function()
  T1:SetCurrentTimecode("01:00:20:00")
  local title = try(function() local x = T1:InsertTitleIntoTimeline("Text"); return x and itemRecord(x) end)
  T1:SetCurrentTimecode("01:00:30:00")
  local fusionTitle = try(function() local x = T1:InsertFusionTitleIntoTimeline("Text+"); return x and itemRecord(x) end)
  T1:SetCurrentTimecode("01:00:40:00")
  local gen = try(function() local x = T1:InsertGeneratorIntoTimeline("Solid Color"); return x and itemRecord(x) end)
  return { title = title, fusionTitle = fusionTitle, generator = gen, tracks = trackList(T1) }
end)
probe("M4", "moveTitle", function()
  for _, it in ipairs(items(T1)) do
    if not it:GetMediaPoolItem() then
      local before = itemRecord(it)
      local ok = it:SetPosition({ startFrame = base + 1500 })
      local trim = it:SetRightOffset((it:GetRightOffset() or 0) + 10)
      return { before = before, moved = ok, trimmed = trim, after = itemRecord(it) }
    end
  end
  return "no item without media"
end)
probe("M4", "addTransition", function()
  local v = T1:GetItemListInTrack("video", 1) or {}
  local it = v[1]
  if not it then return "no item" end
  local countBefore = #v
  local ret = try(function() return it:AddTransition({ type = "Cross Dissolve", category = "simple", position = "end", alignment = "center", duration = 12 }) end)
  return { ret = ret, countBefore = countBefore, countAfter = #(T1:GetItemListInTrack("video", 1) or {}), all = records(T1) }
end)
probe("M4", "compoundClip", function()
  local v2 = T1:GetItemListInTrack("video", 2) or {}
  if #v2 == 0 then return "no item on V2" end
  local cc = T1:CreateCompoundClip({ v2[1] }, { name = "RC Compound" })
  return { created = cc ~= nil, record = cc and itemRecord(cc), poolType = cc and try(function() return cc:GetMediaPoolItem():GetClipProperty("Type") end) }
end)

-- Titles and generators without rippling: insert past the end, then move ------
-- (Insert*IntoTimeline is an insert edit at the playhead that ripples every
-- track, so the playhead goes after the last item first.)

probe("M4", "titleInsertAtEndThenMove", function()
  local T4 = mp:CreateEmptyTimeline("RC T4")
  proj:SetCurrentTimeline(T4)
  local b4 = T4:GetStartFrame()
  mp:AppendToTimeline({ { mediaPoolItem = spare, mediaType = 1, trackIndex = 1, recordFrame = b4 } })
  mp:AppendToTimeline({ { mediaPoolItem = alt, mediaType = 1, trackIndex = 1, recordFrame = b4 + 480 } })
  T4:AddTrack("video")
  local before = records(T4)
  local endFrame = T4:GetEndFrame()
  local function atEnd(insert)
    -- the playhead is set by timecode; past the end by one second
    local fps = 24
    local f = T4:GetEndFrame() + fps - T4:GetStartFrame()
    local tc = string.format("01:%02d:%02d:%02d", math.floor(f / fps / 60), math.floor(f / fps) % 60, f % fps)
    T4:SetCurrentTimecode(tc)
    return insert()
  end
  local out = { endFrame = endFrame }
  local text = atEnd(function() return T4:InsertTitleIntoTimeline("Text") end)
  out.textInserted = text and itemRecord(text)
  out.othersAfterInsert = records(T4)
  if text then
    out.textMove = text:SetPosition({ startFrame = b4 + 300, trackIndex = 2 })
    out.textAfterMove = itemRecord(text)
    out.textTrimRight = try(function() return text:SetRightOffset(30) end)
    out.textTrimLeft = try(function() return text:SetLeftOffset(10) end)
    out.textAfterTrim = itemRecord(text)
  end
  local plus = atEnd(function() return T4:InsertFusionTitleIntoTimeline("Text+") end)
  if plus then
    out.plusInserted = itemRecord(plus)
    out.plusMove = plus:SetPosition({ startFrame = b4 + 260, trackIndex = 1 })
    out.plusTrimRight = try(function() return plus:SetRightOffset((plus:GetRightOffset() or 0) + 40) end)
    out.plusTrimLeft = try(function() return plus:SetLeftOffset((plus:GetLeftOffset() or 0) + 10) end)
    out.plusAfter = itemRecord(plus)
  end
  local gen = atEnd(function() return T4:InsertGeneratorIntoTimeline("Solid Color") end)
  if gen then
    out.genMove = gen:SetPosition({ startFrame = b4 + 800, trackIndex = 2 })
    out.genTrimRight = try(function() return gen:SetRightOffset(20) end)
    out.genAfter = itemRecord(gen)
  end
  out.before = before
  out.after = records(T4)
  proj:SetCurrentTimeline(T1)
  return out
end)

-- Tracks and timeline operations ----------------------------------------------

probe("M4", "trackOps", function()
  local added = T1:AddTrack("video")
  local n = T1:GetTrackCount("video")
  return {
    added = added,
    rename = T1:SetTrackName("video", n, "RC Track"),
    disable = T1:SetTrackEnable("video", n, false),
    lock = T1:SetTrackLock("video", n, true),
    tracks = trackList(T1),
    deleteLocked = try(function() return T1:DeleteTrack("video", n) end),
    after = trackList(T1),
  }
end)
probe("M4", "timelineOps", function()
  local renamed = T2:SetName("RC T2 renamed")
  local dup = T1:DuplicateTimeline("RC T1 copy")
  local origIds, dupIds = {}, {}
  for _, it in ipairs(items(T1)) do origIds[#origIds + 1] = it:GetUniqueId() end
  if dup then for _, it in ipairs(items(dup)) do dupIds[#dupIds + 1] = it:GetUniqueId() end end
  local dupRc = dup and try(function() return dup:GetMediaPoolItem():GetThirdPartyMetadata("rcId") end)
  local deleted = dup and mp:DeleteTimelines({ dup })
  return { renamed = renamed, duplicated = dup ~= nil, origIds = origIds, dupIds = dupIds, dupRcId = dupRc,
    deleted = deleted, names = timelineNames(proj), current = proj:GetCurrentTimeline():GetName() }
end)

-- .drt round trip --------------------------------------------------------------

local drt = STATE_DIR .. "\\out\\m4-t1.drt"
probe("M4", "drtRoundTrip", function()
  local exported = T1:Export(drt, R.EXPORT_DRT, R.EXPORT_NONE)
  local poolBefore = #(root:GetClipList() or {})
  local imported = mp:ImportTimelineFromFile(drt, { timelineName = "RC T1 drt", importSourceClips = false })
  local cur = proj:GetCurrentTimeline():GetName()
  local recs = imported and records(imported)
  local rc = imported and try(function() return imported:GetMediaPoolItem():GetThirdPartyMetadata("rcId") end)
  return { exported = exported, imported = imported ~= nil, currentAfterImport = cur, poolBefore = poolBefore,
    poolAfter = #(root:GetClipList() or {}), rcId = rc, items = recs, original = records(T1) }
end)

-- Snapshot cost ----------------------------------------------------------------

probe("M4", "readCost", function()
  local list = items(T1)
  local t0 = now()
  for _ = 1, 20 do
    for _, it in ipairs(items(T1)) do
      it:GetUniqueId(); it:GetStart(); it:GetEnd(); it:GetLeftOffset(); it:GetRightOffset(); it:GetTrackTypeAndIndex()
    end
  end
  local light = (now() - t0) / 20 / #list
  t0 = now()
  for _ = 1, 20 do for _, it in ipairs(list) do itemRecord(it) end end
  local full = (now() - t0) / 20 / #list
  return { items = #list, perItemLightMs = ms(light), perItemFullMs = ms(full) }
end)

-- Persistence: save, reopen -----------------------------------------------------

results.persist.before = { t1 = records(T1), t2 = records(findTimeline(proj, "RC T2 renamed") or T2), tracks = trackList(T1),
  timelines = timelineNames(proj), t1Id = T1:GetUniqueId() }
probe("M4", "saveScratch", function() return pm:SaveProject() end)
restore()
local reopened = probe("M4", "reopenScratch", function() return pm:LoadProject(scratchName) end)
if reopened then
  local t1 = findTimeline(reopened, "RC T1")
  local t2 = findTimeline(reopened, "RC T2 renamed")
  results.persist.reopened = { t1 = t1 and records(t1), t2 = t2 and records(t2), tracks = t1 and trackList(t1),
    timelines = timelineNames(reopened), t1Id = t1 and t1:GetUniqueId(),
    t1RcId = t1 and try(function() return t1:GetMediaPoolItem():GetThirdPartyMetadata("rcId") end) }
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
