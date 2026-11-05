-- ResolveCollab M9 probe: a proxy standing in for a clip whose original is
-- missing, and swapped for the original later (SPEC §25).
--
-- Run from Workspace > Scripts > ResolveCollab_MediaProbe while
-- `node tools/feasibility/collect.ts --name m9-media` is running.
--
-- Safety: every edit happens inside a new scratch project created by this
-- script. The project that was open is saved first, never modified, and
-- reopened at the end.
--
-- Media (local/feasibility/media): camera.mp4 (1920x1080, 24 fps, 240 frames,
-- start TC 10:00:00:00) and "camera (proxy).mp4" (960x540, same frames and TC).
-- Questions:
--   * Imported as the clip, does the proxy keep the original's frames and start TC?
--   * ReplaceClip(original) on it: do the clip's tag (third-party metadata),
--     name, colour and its timeline item's source range and zoom survive?
--   * The same with LinkFullResolutionMedia(original) instead.
--   * LinkProxyMedia on a clip that has its original (the sender's side).
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


local KEYS = { "Clip Name", "File Name", "File Path", "Resolution", "FPS", "Frames", "Start TC", "End TC", "Duration", "Proxy", "Proxy Media Path", "Clip Color", "Video Codec", "Online Status" }

local function clipInfo(c)
  if not c then return "no clip" end
  local all = c:GetClipProperty() or {}
  local out = {}
  for _, k in ipairs(KEYS) do out[k] = all[k] end
  out.rcId = try(function() return c:GetThirdPartyMetadata("rcId") end)
  out.color = try(function() return c:GetClipColor() end)
  out.name = try(function() return c:GetName() end)
  out.mediaId = try(function() return c:GetMediaId() end)
  return out
end

local function itemInfo(it)
  if not it then return "no item" end
  return {
    name = try(function() return it:GetName() end),
    start = try(function() return it:GetStart() end),
    duration = try(function() return it:GetDuration() end),
    leftOffset = try(function() return it:GetLeftOffset() end),
    sourceStart = try(function() return it:GetSourceStartFrame() end),
    sourceEnd = try(function() return it:GetSourceEndFrame() end),
    zoomX = try(function() return it:GetProperty("ZoomX") end),
    pan = try(function() return it:GetProperty("Pan") end),
    clip = try(function() local m = it:GetMediaPoolItem() return m and m:GetName() end),
  }
end

local function findClip(folder, name)
  for _, c in ipairs(folder:GetClipList() or {}) do
    if c:GetName() == name then return c end
  end
end

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

local scratchName = "ResolveCollab M9 Media Probe " .. string.sub(bmd.createuuid(), 1, 8)
local proj = probe("SAFE", "createScratchProject", function() return pm:CreateProject(scratchName) end)
if not proj then
  finish("Scratch project could not be created; no edits were made.")
  return
end
results.scratchName = scratchName
local mp = proj:GetMediaPool()
local root = mp:GetRootFolder()
local ORIGINAL = MEDIA .. "camera.mp4"
local PROXY = MEDIA .. "camera (proxy).mp4"

-- The original, imported normally, for comparison; and the proxy as a stand-in.
probe("IMPORT", "original", function() return #(mp:ImportMedia({ ORIGINAL }) or {}) end)
local real = findClip(root, "camera.mp4")
local A = (mp:ImportMedia({ PROXY }) or {})[1]
results.realClip = clipInfo(real)
results.proxyClip = clipInfo(A)
if not (real and A) then
  restore()
  finish("Test media could not be imported; stopped.")
  return
end

-- Make the stand-in look like the session's clip: its name, tag and colour.
probe("STANDIN", "nameTagColour", function()
  return { name = A:SetClipProperty("Clip Name", "camera.mp4"), tag = A:SetThirdPartyMetadata({ rcId = "rc:standin-a" }), color = A:SetClipColor("Orange"), after = clipInfo(A) }
end)

local tl = mp:CreateEmptyTimeline("RC Media")
proj:SetCurrentTimeline(tl)
local base = tl:GetStartFrame()
-- Frames 24..119 of the clip (1 s to 5 s), and the real clip the same way for comparison.
local itA = probe("STANDIN", "appendStandIn", function() return (mp:AppendToTimeline({ { mediaPoolItem = A, startFrame = 24, endFrame = 119, trackIndex = 1, recordFrame = base } }) or {})[1] end)
local itR = probe("STANDIN", "appendReal", function() return (mp:AppendToTimeline({ { mediaPoolItem = real, startFrame = 24, endFrame = 119, trackIndex = 1, recordFrame = base + 200 } }) or {})[1] end)
probe("STANDIN", "items", function() return { standIn = itemInfo(itA), real = itemInfo(itR) } end)
probe("STANDIN", "zoomStandIn", function() return { set = itA and itA:SetProperty("ZoomX", 1.25), after = itemInfo(itA) } end)

-- Swap 1: ReplaceClip with the original.
probe("REPLACE", "replaceClip", function()
  local ok = A:ReplaceClip(ORIGINAL)
  return { ok = ok, clip = clipInfo(A), item = itemInfo(itA), items = #(tl:GetItemListInTrack("video", 1) or {}) }
end)

-- Swap 2: a second stand-in, swapped with LinkFullResolutionMedia.
local B = (mp:ImportMedia({ PROXY }) or {})[1]
if B then
  B:SetClipProperty("Clip Name", "camera B")
  B:SetThirdPartyMetadata({ rcId = "rc:standin-b" })
  B:SetClipColor("Teal")
  local itB = (mp:AppendToTimeline({ { mediaPoolItem = B, startFrame = 24, endFrame = 119, trackIndex = 2, recordFrame = base } }) or {})[1]
  probe("LINKFULL", "before", function() return { clip = clipInfo(B), item = itemInfo(itB) } end)
  probe("LINKFULL", "linkFullResolution", function()
    local ok = B:LinkFullResolutionMedia(ORIGINAL)
    return { ok = ok, clip = clipInfo(B), item = itemInfo(itB) }
  end)
end

-- The sender's side: a clip with its original gets the proxy attached.
probe("LINKPROXY", "linkProxy", function()
  local ok = real:LinkProxyMedia(PROXY)
  return { ok = ok, clip = clipInfo(real) }
end)
probe("LINKPROXY", "unlinkProxy", function() return { ok = real:UnlinkProxyMedia(), clip = clipInfo(real) } end)

probe("SAVE", "saveScratch", function() return pm:SaveProject() end)
-- Reopened: does the swapped clip keep its tag and the item its range?
probe("SAVE", "reopen", function()
  pm:LoadProject(scratchName)
  local p = pm:GetCurrentProject()
  local r2 = p:GetMediaPool():GetRootFolder()
  local out = {}
  for _, c in ipairs(r2:GetClipList() or {}) do out[#out + 1] = clipInfo(c) end
  local t = p:GetCurrentTimeline()
  local items = {}
  for _, it in ipairs(t and t:GetItemListInTrack("video", 1) or {}) do items[#items + 1] = itemInfo(it) end
  return { clips = out, items = items }
end)
restore()
finish("Completed.")
end

local ok, err = pcall(main)
if not ok then
  results.fatal = tostring(err)
  pcall(restore)
  finish("Stopped by an unexpected error; the original project was reopened if possible.")
end
