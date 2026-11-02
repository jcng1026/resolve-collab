-- ResolveCollab feasibility probe: answers SPEC §15 F1–F12 on this machine.
--
-- Run from Workspace > Scripts > ResolveCollab_Feasibility while
-- `node tools/feasibility/collect.ts` is running.
--
-- Safety: every edit happens inside a new scratch project created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Results are written to Fusion.prefs under keys starting with "RCFeas", as
-- hex-encoded JSON, because Free 21.1 Lua has no file or socket access.
--
-- Every API call used here is listed in docs/resolve-api/DaVinciResolveScript.pyi.

local STATE_DIR = [[__STATE_DIR__]]
local LOOP_SECONDS = 20
local TICK = 0.05

-- The fusion object is needed first: it is the only way to report anything.
local F = fusion or fu or app
local results = { probes = {}, persist = {}, globals = {
  resolve = type(resolve), Resolve = type(Resolve), fusion = type(fusion), fu = type(fu), app = type(app) } }

-- Encoding -------------------------------------------------------------------

-- Converts API return values into plain data (Resolve objects become "<userdata>").
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

-- Same prefix shape as the community bridge ("Global.<Name>."); Fusion.prefs
-- on 21.1.2 Windows stores the key at the top level as RCFeas<Key>.
local PREFIX = "Global.ResolveCollab.RCFeas"

-- SavePrefs can fail while Resolve is still writing the previous save, so a
-- failed save is retried (the community bridge does the same). A save that
-- returns anything but false counts as done.
local saveStats = { calls = 0, retries = 0, gaveUp = 0, returns = {} }

local function save()
  for attempt = 1, 20 do
    saveStats.calls = saveStats.calls + 1
    local ok, ret = pcall(function() return F:SavePrefs() end)
    saveStats.returns[tostring(ok) .. ":" .. tostring(ret)] = true
    if ok and ret ~= false then return true end
    saveStats.retries = saveStats.retries + 1
    bmd.wait(0.1)
  end
  saveStats.gaveUp = saveStats.gaveUp + 1
  return false
end

local function put(key, text)
  if not F then return false end -- no fusion global yet; reporting starts once R:Fusion() is known
  F:SetPrefs(PREFIX .. key, hex(text))
  return save()
end

-- Probing --------------------------------------------------------------------

local function now() return bmd.gettime() end

-- Runs fn, records its return values or error, and returns its values.
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

local function snap(obj, getters)
  local out = {}
  for _, g in ipairs(getters) do out[g] = try(function() return obj[g](obj) end) end
  return out
end

local TRIM = { "GetStart", "GetEnd", "GetDuration", "GetLeftOffset", "GetRightOffset",
  "GetSourceStartFrame", "GetSourceEndFrame", "GetPosition", "GetTrackTypeAndIndex" }
local ITEM = { "GetName", "GetStart", "GetEnd", "GetDuration", "GetLeftOffset", "GetRightOffset",
  "GetSourceStartFrame", "GetSourceEndFrame", "GetPosition", "GetTrackTypeAndIndex",
  "GetClipEnabled", "GetClipColor", "GetProperties", "GetFades", "GetSpeed", "GetMarkers",
  "GetFusionCompCount", "GetFusionCompNameList", "GetEffects", "GetUniqueId",
  "GetCurrentVersion", "GetVersionNameList", "GetFlagList", "GetLinkedItems" }

-- Calls fn and records the reader's view before and after, so a call that
-- reports success without changing anything (SPEC F12) is visible.
local function write(id, label, read, fn)
  probe(id, label, function()
    local before = try(read)
    local ret = fn()
    return { ret = plain(ret), before = before, after = try(read) }
  end)
end

-- The result is split into chunks in case prefs values have a size limit.
local CHUNK = 16000

local function finish(note)
  results.note = note
  results.saveStats = saveStats
  local h = hex(json(results))
  local n = 0
  for i = 1, #h, CHUNK do
    n = n + 1
    F:SetPrefs(PREFIX .. "Result" .. n, string.sub(h, i, i + CHUNK - 1))
  end
  F:SetPrefs(PREFIX .. "ResultCount", hex(tostring(n)))
  save()
  put("Stage", "done")
  -- One more save after a pause, in case the last one was swallowed.
  bmd.wait(1)
  save()
end

-- Environment (F3, sandbox) --------------------------------------------------

put("Stage", "started")
put("Globals", json(results.globals))

-- Shipped examples use Resolve(); the plain global and bmd.scriptapp are
-- fallbacks. Each attempt is announced first so a hang shows where it is.
local R
local function accept(obj)
  if type(obj) ~= "userdata" and type(obj) ~= "table" then return nil end
  local ok, name = pcall(function() return obj:GetProductName() end)
  if ok and type(name) == "string" then return obj end
end
put("Stage", "acquire:Resolve()")
if type(Resolve) == "function" then
  local ok, v = pcall(Resolve)
  if ok then R = accept(v) end
end
if not R then put("Stage", "acquire:global"); R = accept(resolve) end
if not R then put("Stage", "acquire:scriptapp"); R = accept(bmd.scriptapp("Resolve")) end
if not R then
  put("Fatal", "no usable Resolve object")
  put("Stage", "done")
  return
end
put("Stage", "acquired")
F = F or R:Fusion()

local function preflight()
probe("F3", "product", function() return R:GetProductName(), R:GetVersionString() end)
probe("F3", "isStudio", function() return R:IsStudio() end)
probe("F3", "mapPaths", function()
  return { scripts = F:MapPath("Scripts:"), profile = F:MapPath("Profile:"), userData = F:MapPath("UserData:") }
end)
probe("ENV", "sandbox", function()
  local o = type(os) == "table" and os or {}
  return {
    io = type(io), os = type(os), osGetenv = type(o.getenv), osExecute = type(o.execute),
    osRemove = type(o.remove), osTime = type(o.time), require = type(require),
    package = type(package), ffi = type(ffi), debug = type(debug), loadfile = type(loadfile),
    loadstring = type(loadstring), setfenv = type(setfenv), dofile = type(dofile),
    bmdReadfile = type(bmd.readfile), bmdWritefile = type(bmd.writefile),
    bmdFileexists = type(bmd.fileexists), bmdWait = type(bmd.wait), bmdGettime = type(bmd.gettime),
  }
end)
local perSecond = probe("ENV", "gettimeUnitsPerSecond", function()
  local a = now(); bmd.wait(1); return now() - a
end) or 1
probe("F2", "savePrefsReturn", function() return put("Hello", "hello") end)

-- F1/F2: polling loop and request round trip ---------------------------------
-- collect.ts rewrites request.lua with an increasing n; the loop echoes each
-- new n back through prefs, so the round trip is measured on Node's clock.

local REQ = STATE_DIR .. "\\request.lua"

local function loadData(path)
  if not bmd.fileexists(path) then return nil, "missing" end
  local chunk, err = loadfile(path)
  if not chunk then return nil, err end
  if setfenv then setfenv(chunk, {}) end
  local ok, data = pcall(chunk)
  if not ok then return nil, data end
  return data
end

probe("F1", "pollLoop", function()
  local t0, prev = now(), now()
  local ticks, echoes, maxGap, lastN, saves = 0, 0, 0, nil, {}
  while now() - t0 < LOOP_SECONDS * perSecond do
    bmd.wait(TICK)
    ticks = ticks + 1
    local t = now()
    if t - prev > maxGap then maxGap = t - prev end
    prev = t
    local req = loadData(REQ)
    if type(req) == "table" and req.n ~= lastN then
      lastN = req.n
      echoes = echoes + 1
      local s0 = now()
      put("Echo", tostring(req.n))
      saves[#saves + 1] = now() - s0
    end
  end
  return { ticks = ticks, echoes = echoes, elapsed = now() - t0, maxGap = maxGap, saveDt = saves }
end)

-- §13: a request file containing code must not reach anything in an empty env.
probe("SEC", "emptyEnvBlocksCode", function()
  local data, err = loadData(STATE_DIR .. "\\attack.lua")
  return { data = plain(data), err = tostring(err) }
end)
end

local preflightOk, preflightErr = pcall(preflight)
if not preflightOk then
  results.fatal = tostring(preflightErr)
  finish("Stopped during preflight; no project was touched.")
  return
end

-- Scratch project ------------------------------------------------------------

local pm = R:GetProjectManager()
local orig = pm:GetCurrentProject()
local origName = orig and orig:GetName()

local function restore()
  if origName then probe("SAFE", "reopenOriginal", function() return pm:LoadProject(origName) ~= nil end) end
end

local function main()
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab Feasibility " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName

local mp = proj:GetMediaPool()
local MEDIA = STATE_DIR .. "\\media\\"

local imported = probe("F4", "importMedia", function()
  return mp:ImportMedia({ { FilePath = MEDIA .. "original.mp4" }, { FilePath = MEDIA .. "spare.mp4" } })
end)
local clip = imported and imported[1]
local spare = imported and imported[2]
if not clip then
  restore()
  finish("Test media could not be imported; stopped before timeline tests.")
  return
end
probe("F4", "clipProperties", function() return clip:GetClipProperty() end)

local tl = probe("F4", "createEmptyTimeline", function() return mp:CreateEmptyTimeline("RC Test") end)
probe("F4", "setCurrentTimeline", function() return proj:SetCurrentTimeline(tl) end)
local start = tl:GetStartFrame()

probe("F4", "appendWithRecordFrame", function()
  return mp:AppendToTimeline({
    { mediaPoolItem = clip, startFrame = 0, endFrame = 47, trackIndex = 1, recordFrame = start },
    { mediaPoolItem = clip, startFrame = 60, endFrame = 107, trackIndex = 1, recordFrame = start + 100 },
    { mediaPoolItem = clip, startFrame = 120, endFrame = 167, trackIndex = 1, recordFrame = start + 200 },
  })
end)
local items = tl:GetItemListInTrack("video", 1) or {}
local A, B, C = items[1], items[2], items[3]
results.itemCount = #items
if not (A and B and C) then
  restore()
  finish("AppendToTimeline did not produce three items; stopped.")
  return
end

-- F8 presence ------------------------------------------------------------------
probe("F8", "currentPage", function() return R:GetCurrentPage() end)
probe("F8", "openEditPage", function() return R:OpenPage("edit"), R:GetCurrentPage() end)
probe("F8", "currentTimecode", function() return tl:GetCurrentTimecode() end)
probe("F8", "setTimecode", function() return tl:SetCurrentTimecode(tl:GetStartTimecode()), tl:GetCurrentTimecode() end)
probe("F8", "currentVideoItem", function() local it = tl:GetCurrentVideoItem() return it and it:GetUniqueId() end)
probe("F8", "selectedTimelineClips", function() return tl:GetSelectedClips() end)
probe("F8", "selectedMediaPoolClips", function() return mp:GetSelectedClips() end)

-- F10 identity -------------------------------------------------------------------
probe("F10", "uniqueIds", function()
  return { clip = clip:GetUniqueId(), mediaId = clip:GetMediaId(), item = A:GetUniqueId(),
    timeline = tl:GetUniqueId(), project = proj:GetUniqueId(), rootFolder = mp:GetRootFolder():GetUniqueId() }
end)
write("F10", "thirdPartyMetadata", function() return clip:GetThirdPartyMetadata("ResolveCollabId") end,
  function() return clip:SetThirdPartyMetadata({ ResolveCollabId = "rc-test-1" }) end)
write("F10", "itemMarkerCustomData", function() return A:GetMarkerByCustomData("rc-marker-1") end,
  function() return A:AddMarker(5, "Blue", "RC", "probe", 1, "rc-marker-1") end)

-- F5 read-back of everything an item carries ---------------------------------------
probe("F5", "itemSnapshot", function() return snap(A, ITEM) end)

-- F4 edits, each with before/after -------------------------------------------------
write("F4", "setLeftOffset", function() return snap(A, TRIM) end,
  function() return A:SetLeftOffset(A:GetLeftOffset() + 10) end)
write("F4", "setRightOffset", function() return snap(A, TRIM) end,
  function() return A:SetRightOffset(A:GetRightOffset() + 10) end)
write("F4", "setPositionFrame", function() return snap(B, TRIM) end,
  function() return B:SetPosition({ startFrame = B:GetStart() + 12 }) end)
write("F4", "moveItems", function() return snap(B, TRIM) end,
  function() return tl:MoveItems({ B }, { startFrame = B:GetStart() + 12 }) end)
write("F4", "addVideoTrack", function() return tl:GetTrackCount("video") end,
  function() return tl:AddTrack("video") end)
write("F4", "setPositionTrack", function() return snap(B, TRIM) end,
  function() return B:SetPosition({ trackIndex = 2 }) end)
write("F4", "setProperties", function() local p = A:GetProperties() return { ZoomX = p.ZoomX, Pan = p.Pan } end,
  function() return A:SetProperties({ ZoomX = 1.5, Pan = 20 }) end)
write("F4", "setClipEnabled", function() return A:GetClipEnabled() end,
  function() return A:SetClipEnabled(false) end)
write("F4", "setClipColor", function() return A:GetClipColor() end,
  function() return A:SetClipColor("Orange") end)
write("F4", "setFades", function() return A:GetFades() end,
  function() return A:SetFades({ FadeIn = 5, FadeOut = 5 }) end)
write("F4", "setSpeed", function() return C:GetSpeed() end,
  function() return C:SetSpeed({ Percentage = 50 }) end)
write("F4", "itemSetName", function() return A:GetName() end,
  function() return A:SetName("RC renamed") end)
write("F4", "timelineMarker", function() return tl:GetMarkers() end,
  function() return tl:AddMarker(start + 10, "Green", "RC", "timeline marker", 1, "rc-tl-1") end)
write("F4", "addFusionComp", function() return A:GetFusionCompCount() end,
  function() return A:AddFusionComp() ~= nil end)
probe("F4", "exportFusionComp", function() return A:ExportFusionComp(STATE_DIR .. "\\out\\comp.comp", 1) end)
write("F4", "deleteClip", function() return #(tl:GetItemListInTrack("video", 1) or {}) end,
  function() return tl:DeleteClips({ C }, false) end)
write("F4", "timelineSetName", function() return tl:GetName() end,
  function() return tl:SetName("RC Test Renamed") end)
write("F4", "setTrackName", function() return tl:GetTrackName("video", 1) end,
  function() return tl:SetTrackName("video", 1, "RC V1") end)
probe("F4", "duplicateTimeline", function() local d = tl:DuplicateTimeline("RC Duplicate") return d and d:GetName() end)

-- Media pool edits
local root = mp:GetRootFolder()
local bin = probe("F4", "addSubFolder", function() return mp:AddSubFolder(root, "RC Bin") end)
write("F4", "moveClips", function() return #(bin and bin:GetClipList() or {}) end,
  function() return mp:MoveClips({ spare }, bin) end)
write("F4", "clipSetName", function() return spare:GetName() end,
  function() return spare:SetName("RC Spare") end)
write("F4", "clipSetColor", function() return spare:GetClipColor() end,
  function() return spare:SetClipColor("Teal") end)
write("F4", "clipSetMetadata", function() return spare:GetMetadata() end,
  function() return spare:SetMetadata({ Comments = "rc probe" }) end)
-- Folder has no SetName in the API stub; confirm bins really can't be renamed.
write("F4", "folderSetName", function() return bin:GetName() end,
  function() return bin:SetName("RC Bin Renamed") end)

-- F9 media relinking -------------------------------------------------------------
write("F9", "linkProxyMedia", function() return clip:GetClipProperty() end,
  function() return clip:LinkProxyMedia(MEDIA .. "proxy.mp4") end)
write("F9", "replaceClip", function() return spare:GetClipProperty() end,
  function() return spare:ReplaceClip(MEDIA .. "alt.mp4") end)
write("F9", "relinkClips", function() return spare:GetClipProperty() end,
  function() return mp:RelinkClips({ spare }, MEDIA .. "moved") end)

-- F6 timeline swap via .drt ----------------------------------------------------------
local drt = STATE_DIR .. "\\out\\timeline.drt"
probe("F6", "exportDrt", function() return tl:Export(drt, R.EXPORT_DRT, R.EXPORT_NONE) end)
probe("F6", "importDrt", function()
  local t2 = mp:ImportTimelineFromFile(drt)
  return t2 and { name = t2:GetName(), videoItems = #(t2:GetItemListInTrack("video", 1) or {}) }
end)
probe("F6", "exportOtio", function() return tl:Export(STATE_DIR .. "\\out\\timeline.otio", R.EXPORT_OTIO, R.EXPORT_NONE) end)

-- F11 snapshot cost ---------------------------------------------------------------
local big = probe("F11", "createBigTimeline", function()
  local t = mp:CreateEmptyTimeline("RC Snapshot")
  proj:SetCurrentTimeline(t)
  local s, infos = t:GetStartFrame(), {}
  for i = 1, 300 do
    infos[i] = { mediaPoolItem = clip, startFrame = i % 200, endFrame = i % 200 + 1, trackIndex = 1, recordFrame = s + i * 3 }
  end
  mp:AppendToTimeline(infos)
  return t
end)
if big then
  probe("F11", "snapshotLight", function()
    local t0, list = now(), big:GetItemListInTrack("video", 1) or {}
    for _, it in ipairs(list) do it:GetStart(); it:GetEnd(); it:GetLeftOffset(); it:GetRightOffset(); it:GetUniqueId() end
    return { items = #list, dt = now() - t0 }
  end)
  probe("F11", "snapshotFull", function()
    local t0, list = now(), big:GetItemListInTrack("video", 1) or {}
    for _, it in ipairs(list) do snap(it, ITEM) end
    return { items = #list, dt = now() - t0 }
  end)
  proj:SetCurrentTimeline(tl)
end

-- F7 project export/import ----------------------------------------------------------
probe("F7", "saveScratch", function() return pm:SaveProject() end)
local drp = STATE_DIR .. "\\out\\scratch.drp"
probe("F7", "exportProject", function() return pm:ExportProject(scratchName, drp, false) end)
probe("F7", "importProject", function() return pm:ImportProject(drp, scratchName .. " imported") end)

-- F12 persistence: reopen the scratch project and read the same things again -------
results.persist.before = { A = snap(A, ITEM), B = snap(B, TRIM), spare = snap(spare, { "GetName", "GetClipColor", "GetMetadata", "GetClipProperty" }) }
restore()
local reopened = probe("F12", "reopenScratch", function() return pm:LoadProject(scratchName) end)
if reopened then
  probe("F12", "readAfterReopen", function()
    local mp2 = reopened:GetMediaPool()
    local t
    for i = 1, reopened:GetTimelineCount() do
      local x = reopened:GetTimelineByIndex(i)
      if x:GetName() == "RC Test Renamed" then t = x end
    end
    if not t then return "timeline not found" end
    local v1, v2 = t:GetItemListInTrack("video", 1) or {}, t:GetItemListInTrack("video", 2) or {}
    local sp
    for _, c in ipairs(mp2:GetRootFolder():GetSubFolderList() or {}) do
      for _, x in ipairs(c:GetClipList() or {}) do sp = x end
    end
    results.persist.after = { A = v1[1] and snap(v1[1], ITEM), B = v2[1] and snap(v2[1], TRIM),
      spare = sp and snap(sp, { "GetName", "GetClipColor", "GetMetadata", "GetClipProperty" }) }
    return true
  end)
  restore()
end

finish("Completed.")
end

local ok, err = pcall(main)
if not ok then
  results.fatal = tostring(err)
  pcall(restore)
  finish("Stopped by an unexpected error; the original project was reopened if possible.")
end
