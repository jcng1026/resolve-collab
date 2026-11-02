-- ResolveCollab M3 probe: media pool calls on this machine (SPEC §19).
--
-- Run from Workspace > Scripts > ResolveCollab_MediaPoolProbe while
-- `node tools/feasibility/collect.ts --name m3` is running.
--
-- Safety: every edit happens inside new scratch projects created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Results leave as errors raised inside fusion:Execute, which Resolve writes
-- to Support/logs/ResolveDebug.txt at once (see ResolveCollab_Feasibility.lua).
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

-- Media pool helpers ---------------------------------------------------------

local function findSub(folder, name)
  for _, f in ipairs(folder:GetSubFolderList() or {}) do
    if f:GetName() == name then return f end
  end
end

local function findClip(folder, name)
  for _, c in ipairs(folder:GetClipList() or {}) do
    if c:GetName() == name then return c end
  end
end

-- Names of everything below folder: { "A/", "A/clip.mp4", ... }.
local function tree(folder, prefix, out)
  out = out or {}
  prefix = prefix or ""
  for _, c in ipairs(folder:GetClipList() or {}) do out[#out + 1] = prefix .. c:GetName() end
  for _, f in ipairs(folder:GetSubFolderList() or {}) do
    out[#out + 1] = prefix .. f:GetName() .. "/"
    tree(f, prefix .. f:GetName() .. "/", out)
  end
  return out
end

-- Everything ResolveCollab would snapshot about a clip.
local function clipRecord(c)
  return {
    name = try(function() return c:GetName() end),
    uniqueId = try(function() return c:GetUniqueId() end),
    mediaId = try(function() return c:GetMediaId() end),
    color = try(function() return c:GetClipColor() end),
    metadata = try(function() return c:GetMetadata() end),
    thirdParty = try(function() return c:GetThirdPartyMetadata() end),
    flags = try(function() return c:GetFlagList() end),
    parent = try(function() return c:GetParentFolder():GetName() end),
    filePath = try(function() return c:GetClipProperty("File Path") end),
    type = try(function() return c:GetClipProperty("Type") end),
  }
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
probe("SAFE", "saveOriginal", function() return origName, pm:SaveProject() end)

local scratchName = "ResolveCollab M3 Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()

-- Bins and importing into a chosen bin ---------------------------------------

local A = probe("M3", "addSubFolder", function() return mp:AddSubFolder(root, "A") end)
local sub = probe("M3", "addNestedSubFolder", function() return mp:AddSubFolder(A, "Sub") end)
probe("M3", "folderIds", function()
  return { root = root:GetUniqueId(), A = A:GetUniqueId(), sub = sub:GetUniqueId(),
    subParent = sub:GetParentFolder():GetName() }
end)
probe("M3", "duplicateFolderName", function()
  local dup = mp:AddSubFolder(root, "A")
  local names = {}
  for _, f in ipairs(root:GetSubFolderList() or {}) do names[#names + 1] = f:GetName() end
  local deleted = dup and mp:DeleteFolders({ dup })
  return { created = dup ~= nil, namesWithDup = names, deletedDup = deleted, after = tree(root) }
end)

probe("M3", "importIntoChosenFolder", function()
  local before = mp:GetCurrentFolder():GetName()
  local set = mp:SetCurrentFolder(A)
  local items = mp:ImportMedia({ MEDIA .. "original.mp4", MEDIA .. "spare.mp4", MEDIA .. "alt.mp4" })
  local back = mp:SetCurrentFolder(root)
  return { currentBefore = before, setCurrent = set, imported = items and #items or 0,
    currentAfter = mp:GetCurrentFolder():GetName(), restored = back, tree = tree(root) }
end)
local original, spare, alt = findClip(A, "original.mp4"), findClip(A, "spare.mp4"), findClip(A, "alt.mp4")
if not (original and spare and alt) then
  restore()
  finish("Test media could not be imported into bin A; stopped.")
  return
end

probe("M3", "reimportSameFile", function()
  mp:SetCurrentFolder(sub)
  local items = mp:ImportMedia({ MEDIA .. "original.mp4" })
  mp:SetCurrentFolder(root)
  return { returned = items and #items or 0, tree = tree(root) }
end)
probe("M3", "importMissingFile", function()
  local items = mp:ImportMedia({ MEDIA .. "does-not-exist.mp4" })
  return { returned = items and #items or 0 }
end)

probe("M3", "clipRecord", function() return clipRecord(original) end)
probe("M3", "clipPropertyKeys", function()
  local keys = {}
  for k in pairs(original:GetClipProperty() or {}) do keys[#keys + 1] = k end
  table.sort(keys)
  return keys
end)

-- Clip edits, each read back --------------------------------------------------

probe("M3", "clipSetName", function()
  local ret = spare:SetName("spare renamed")
  return { ret = ret, name = spare:GetName(), clipName = spare:GetClipProperty("Clip Name"),
    fileName = spare:GetClipProperty("File Name") }
end)
probe("M3", "clipColor", function()
  local set = spare:SetClipColor("Orange")
  local afterSet = spare:GetClipColor()
  local cleared = original:SetClipColor("Teal") and original:ClearClipColor()
  return { set = set, afterSet = afterSet, cleared = cleared, afterClear = original:GetClipColor() }
end)
probe("M3", "clipMetadata", function()
  local ret = spare:SetMetadata({ Scene = "42", Description = "probe ü \"quoted\"" })
  local cleared = spare:SetMetadata({ Scene = "" })
  return { ret = ret, cleared = cleared, after = spare:GetMetadata() }
end)
probe("M3", "thirdPartyMetadata", function()
  local ret = spare:SetThirdPartyMetadata({ rcId = "c-0001" })
  local ret2 = original:SetThirdPartyMetadata({ rcId = "c-0002" })
  return { ret = ret, ret2 = ret2, spare = spare:GetThirdPartyMetadata(), original = original:GetThirdPartyMetadata("rcId") }
end)
probe("M3", "flags", function()
  local ret = spare:AddFlag("Blue")
  return { ret = ret, flags = spare:GetFlagList() }
end)

-- Moving clips and bins -------------------------------------------------------

probe("M3", "moveClips", function()
  local ret = mp:MoveClips({ spare }, sub)
  return { ret = ret, spareParent = spare:GetParentFolder():GetName(), tree = tree(root) }
end)
probe("M3", "moveFolders", function()
  local ret = mp:MoveFolders({ sub }, root)
  return { ret = ret, subParent = sub:GetParentFolder():GetName(), sameId = sub:GetUniqueId(), tree = tree(root) }
end)

-- Bin rename emulated: new bin, move everything, delete the old one -----------

probe("M3", "binRenameEmulated", function()
  local idBefore = A:GetUniqueId()
  local renamed = mp:AddSubFolder(root, "A renamed")
  local moved = mp:MoveClips(A:GetClipList() or {}, renamed)
  local movedFolders = true
  local subs = A:GetSubFolderList() or {}
  if #subs > 0 then movedFolders = mp:MoveFolders(subs, renamed) end
  local deleted = mp:DeleteFolders({ A })
  A = renamed
  return { moved = moved, movedFolders = movedFolders, deleted = deleted, oldId = idBefore,
    newId = renamed:GetUniqueId(), originalStillValid = try(function() return original:GetName() end),
    originalParent = try(function() return original:GetParentFolder():GetName() end), tree = tree(root) }
end)

-- Deleting clips used in a timeline, and bins that hold clips -----------------

local tl = probe("M3", "timelineUsingAlt", function()
  local t = mp:CreateEmptyTimeline("RC M3")
  proj:SetCurrentTimeline(t)
  mp:AppendToTimeline({ { mediaPoolItem = alt }, { mediaPoolItem = original } })
  return t
end)
probe("M3", "deleteClipUsedInTimeline", function()
  local before = #(tl:GetItemListInTrack("video", 1) or {})
  local ret = mp:DeleteClips({ alt })
  return { ret = ret, itemsBefore = before, itemsAfter = #(tl:GetItemListInTrack("video", 1) or {}), tree = tree(root) }
end)
probe("M3", "deleteFolderWithClip", function()
  local doomed = mp:AddSubFolder(root, "Doomed")
  mp:SetCurrentFolder(doomed)
  mp:ImportMedia({ MEDIA .. "proxy.mp4" })
  mp:SetCurrentFolder(root)
  local inside = tree(doomed)
  local ret = mp:DeleteFolders({ doomed })
  return { inside = inside, ret = ret, tree = tree(root) }
end)
probe("M3", "timelineClipsInPool", function()
  local out = {}
  for _, c in ipairs(root:GetClipList() or {}) do
    out[#out + 1] = { name = c:GetName(), type = try(function() return c:GetClipProperty("Type") end),
      isTimeline = try(function() return c:GetTimeline() ~= nil end) }
  end
  return out
end)

-- Snapshot cost ---------------------------------------------------------------

probe("M3", "walkCost", function()
  local clips = {}
  local function collect(f)
    for _, c in ipairs(f:GetClipList() or {}) do clips[#clips + 1] = c end
    for _, s in ipairs(f:GetSubFolderList() or {}) do collect(s) end
  end
  local t0 = now()
  for _ = 1, 50 do clips = {}; collect(root) end
  local walk = (now() - t0) / 50
  t0 = now()
  for _ = 1, 50 do for _, c in ipairs(clips) do clipRecord(c) end end
  local perClipFull = (now() - t0) / 50 / #clips
  t0 = now()
  for _ = 1, 50 do
    for _, c in ipairs(clips) do c:GetName(); c:GetClipColor(); c:GetParentFolder():GetUniqueId() end
  end
  local perClipLight = (now() - t0) / 50 / #clips
  return { clips = #clips, walkMs = walk / perSecond * 1000,
    perClipFullMs = perClipFull / perSecond * 1000, perClipLightMs = perClipLight / perSecond * 1000 }
end)

-- Persistence: save, reopen, and through a .drp ------------------------------

local function capture(p)
  local r = p:GetMediaPool():GetRootFolder()
  local folders, clips = {}, {}
  local function walk(f, path)
    folders[path] = f:GetUniqueId()
    for _, c in ipairs(f:GetClipList() or {}) do clips[path .. c:GetName()] = clipRecord(c) end
    for _, s in ipairs(f:GetSubFolderList() or {}) do walk(s, path .. s:GetName() .. "/") end
  end
  walk(r, "/")
  return { folders = folders, clips = clips }
end

results.persist.before = capture(proj)
probe("M3", "saveScratch", function() return pm:SaveProject() end)
local drp = STATE_DIR .. "\\out\\m3.drp"
probe("M3", "exportProject", function() return pm:ExportProject(scratchName, drp, false) end)
probe("M3", "importProject", function() return pm:ImportProject(drp, scratchName .. " imported") end)

restore()
local reopened = probe("M3", "reopenScratch", function() return pm:LoadProject(scratchName) end)
if reopened then results.persist.reopened = capture(reopened) end
local imported = probe("M3", "openImported", function() return pm:LoadProject(scratchName .. " imported") end)
if imported then results.persist.imported = capture(imported) end
restore()

finish("Completed.")
end

local ok, err = pcall(main)
if not ok then
  results.fatal = tostring(err)
  pcall(restore)
  finish("Stopped by an unexpected error; the original project was reopened if possible.")
end
