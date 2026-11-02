-- ResolveCollab bridge (SPEC §3, §18, §19). Runs inside DaVinci Resolve from
-- Workspace > Scripts > ResolveCollab and talks to the companion app:
--   out: errors raised through fusion:Execute, which Resolve writes to
--        Support/logs/ResolveDebug.txt as  RC|<bridgeId>|<kind>|<hex(JSON)>,
--        long messages split across lines ending |<part>/<parts>/<msgId>
--   in:  subfolders of the inbox named  <seq:8>.<part:3>.<parts:3>.<hex(JSON)>,
--        listed with MediaStorage:GetSubFolderList (Free has no file reads).
-- Inbound text is only ever parsed as JSON by jdecode below, never executed.

-- Tests load this file with loadfile(path)("test") to get the pure helpers.
local MODE = ...

local INBOX = [[__INBOX__]]
local TICK = 0.05
local SNAPSHOT_EVERY = 0.3
local MEDIA_POOL_EVERY = 0.6
local MEDIA_POOL_BUDGET = 60 -- existing clips fully re-read per media pool scan
local HEARTBEAT_EVERY = 1
local MAX_OUT_HEX = 1500 -- log lines are cut at ~2000 characters

local M = {}

-- Encoding --------------------------------------------------------------------

function M.hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

function M.unhex(h)
  if #h % 2 ~= 0 or h:find("[^0-9a-fA-F]") then error("bad hex") end
  return (h:gsub("..", function(x) return string.char(tonumber(x, 16)) end))
end

local function jstr(s)
  return '"' .. (s:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end)) .. '"'
end

function M.jencode(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if v == math.floor(v) and math.abs(v) < 2 ^ 53 then return string.format("%d", v) end
    return string.format("%.17g", v)
  end
  if t == "string" then return jstr(v) end
  if t == "table" then
    local parts = {}
    if v[1] ~= nil then
      for i = 1, #v do parts[i] = M.jencode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    -- Sorted keys, so the same record always encodes the same way.
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    for _, k in ipairs(keys) do
      local x = v[k]
      if x == nil then x = v[tonumber(k)] end
      parts[#parts + 1] = jstr(k) .. ":" .. M.jencode(x)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return jstr("<" .. t .. ">")
end

local function utf8char(code)
  if code < 0x80 then return string.char(code) end
  if code < 0x800 then return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40) end
  if code < 0x10000 then
    return string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
  end
  return string.char(0xF0 + math.floor(code / 0x40000), 0x80 + math.floor(code / 0x1000) % 0x40,
    0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
end

local ESCAPES = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

-- Strict JSON decoder. JSON null becomes nil.
function M.jdecode(s)
  local pos = 1
  local function ws() pos = s:find("[^ \t\r\n]", pos) or #s + 1 end
  local function str()
    pos = pos + 1
    local out = {}
    while true do
      local c = s:sub(pos, pos)
      if c == "" then error("unterminated string") end
      if c == '"' then pos = pos + 1; return table.concat(out) end
      if c == "\\" then
        local e = s:sub(pos + 1, pos + 1)
        if ESCAPES[e] then
          out[#out + 1] = ESCAPES[e]; pos = pos + 2
        elseif e == "u" then
          local code = tonumber(s:sub(pos + 2, pos + 5), 16)
          if not code or #s:sub(pos + 2, pos + 5) ~= 4 then error("bad \\u escape") end
          pos = pos + 6
          if code >= 0xD800 and code <= 0xDBFF and s:sub(pos, pos + 1) == "\\u" then
            local low = tonumber(s:sub(pos + 2, pos + 5), 16)
            if low and low >= 0xDC00 and low <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
              pos = pos + 6
            end
          end
          out[#out + 1] = utf8char(code)
        else
          error("bad escape")
        end
      else
        local stop = s:find('["\\]', pos)
        if not stop then error("unterminated string") end
        out[#out + 1] = s:sub(pos, stop - 1)
        pos = stop
      end
    end
  end
  local value
  function value(depth)
    if depth > 32 then error("nesting too deep") end
    ws()
    local c = s:sub(pos, pos)
    if c == "{" then
      pos = pos + 1
      local obj = {}
      ws()
      if s:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        ws()
        if s:sub(pos, pos) ~= '"' then error("expected key") end
        local k = str()
        ws()
        if s:sub(pos, pos) ~= ":" then error("expected ':'") end
        pos = pos + 1
        obj[k] = value(depth + 1)
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
        if d ~= "," then error("expected ',' or '}'") end
      end
    elseif c == "[" then
      pos = pos + 1
      local arr = {}
      ws()
      if s:sub(pos, pos) == "]" then pos = pos + 1; return arr end
      while true do
        arr[#arr + 1] = value(depth + 1)
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return arr end
        if d ~= "," then error("expected ',' or ']'") end
      end
    elseif c == '"' then
      return str()
    elseif s:sub(pos, pos + 3) == "true" then
      pos = pos + 4; return true
    elseif s:sub(pos, pos + 4) == "false" then
      pos = pos + 5; return false
    elseif s:sub(pos, pos + 3) == "null" then
      pos = pos + 4; return nil
    end
    local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
    local n = num and tonumber(num)
    if not n then error("unexpected character at " .. pos) end
    pos = pos + #num
    return n
  end
  local v = value(0)
  ws()
  if pos <= #s then error("trailing data") end
  return v
end

-- Inbox -------------------------------------------------------------------------

-- Complete messages newer than lastHandled, oldest first. Accepts full paths
-- or bare folder names; anything else in the folder is ignored.
function M.decodeInbox(paths, lastHandled)
  local bySeq = {}
  for _, path in ipairs(paths) do
    local name = path:match("([^\\/]+)[\\/]?$") or path
    local seq, part, parts, h = name:match("^(%d%d%d%d%d%d%d%d)%.(%d%d%d)%.(%d%d%d)%.([0-9a-f]*)$")
    if seq then
      seq, part, parts = tonumber(seq), tonumber(part), tonumber(parts)
      if seq > lastHandled then
        local entry = bySeq[seq] or { parts = parts, chunks = {}, count = 0 }
        if not entry.chunks[part] then entry.count = entry.count + 1 end
        entry.chunks[part] = h
        bySeq[seq] = entry
      end
    end
  end
  local seqs = {}
  for seq, entry in pairs(bySeq) do
    if entry.count == entry.parts then seqs[#seqs + 1] = seq end
  end
  table.sort(seqs)
  local out = {}
  for _, seq in ipairs(seqs) do
    local entry = bySeq[seq]
    local ok, message = pcall(function() return M.jdecode(M.unhex(table.concat(entry.chunks, "", 1, entry.parts))) end)
    out[#out + 1] = { seq = seq, message = ok and message or nil, error = (not ok) and tostring(message) or nil }
  end
  return out
end

if MODE == "test" then return M end

-- Runtime -------------------------------------------------------------------------

local R = resolve
local F = fusion
local bridgeId = M.hex(string.sub(bmd.createuuid(), 1, 4)) .. string.format("%08x", math.floor(bmd.gettime() * 1000) % 0x100000000)
local ACTIVE_PREF = "Global.ResolveCollab.ActiveBridge"

local MAX_PARTS = 200
local nextMsg = 0

-- kind is a fixed word and the payload hex, so the generated code can't
-- contain a quote or anything else Lua would interpret.
local function emit(kind, payload)
  local h = M.hex(M.jencode(payload))
  if #h <= MAX_OUT_HEX then
    F:Execute('error("RC|' .. bridgeId .. '|' .. kind .. '|' .. h .. '")')
    return
  end
  local parts = math.ceil(#h / MAX_OUT_HEX)
  if parts > MAX_PARTS then
    emit("ERR", { error = "payload-too-large", kind = kind, bytes = #h / 2 })
    return
  end
  nextMsg = nextMsg + 1
  for i = 1, parts do
    local chunk = string.sub(h, (i - 1) * MAX_OUT_HEX + 1, i * MAX_OUT_HEX)
    F:Execute('error("RC|' .. bridgeId .. '|' .. kind .. '|' .. chunk .. '|' .. i .. '/' .. parts .. '/' .. nextMsg .. '")')
  end
end

local pm = R:GetProjectManager()
local ms = R:GetMediaStorage()

local function currentTimeline()
  local project = pm:GetCurrentProject()
  return project and project:GetCurrentTimeline(), project
end

-- Clips the bridge itself appended; they must not be reported as local edits.
local selfAdded = {}
local known, knownTimeline = {}, nil

local function clipInfo(tl, item, track)
  local mpi = item:GetMediaPoolItem()
  local props = mpi and mpi:GetClipProperty() or {}
  return {
    type = "clip.added",
    timeline = tl:GetName(),
    track = track,
    start = item:GetStart(),
    ["end"] = item:GetEnd(),
    srcStart = item:GetSourceStartFrame(),
    srcEnd = item:GetSourceEndFrame(),
    media = { name = props["File Name"] or (mpi and mpi:GetName()) or "", path = props["File Path"] or "",
      frames = tonumber(props["Frames"]) or 0 },
  }
end

-- Video items only; linked audio follows its video clip.
local function scanTimeline(report)
  local tl = currentTimeline()
  if not tl then return end
  local tlId = tl:GetUniqueId()
  if tlId ~= knownTimeline then
    known, knownTimeline, report = {}, tlId, false -- switching timelines is not an edit
  end
  for track = 1, tl:GetTrackCount("video") do
    for _, item in ipairs(tl:GetItemListInTrack("video", track) or {}) do
      local uid = item:GetUniqueId()
      if not known[uid] then
        known[uid] = true
        if report and not selfAdded[uid] then emit("EVT", clipInfo(tl, item, track)) end
      end
    end
  end
end

local function findMedia(folder, fileName)
  for _, clip in ipairs(folder:GetClipList() or {}) do
    local props = clip:GetClipProperty() or {}
    if props["File Name"] == fileName then return clip end
  end
  for _, sub in ipairs(folder:GetSubFolderList() or {}) do
    local found = findMedia(sub, fileName)
    if found then return found end
  end
end

-- Media pool (SPEC §19.4) ------------------------------------------------------------
-- Last-seen state by local unique ID: { obj, sig } for bins, plus { bin } for
-- clips. A record whose encoding (sig) changes is reported as an edit.

local mpBins, mpClips, mpOrder, mpCursor, mpProject = {}, {}, {}, 1, nil
local timelineClips = {} -- timelines show up in the pool; M3 leaves them alone

local function mediaPool()
  return pm:GetCurrentProject():GetMediaPool()
end

local function flagList(clip)
  local out = {}
  for _, f in ipairs(clip:GetFlagList() or {}) do
    if type(f) == "string" then out[#out + 1] = f end
  end
  table.sort(out)
  return out
end

local function metaOf(clip)
  local out = {}
  for k, v in pairs(clip:GetMetadata() or {}) do
    if type(k) == "string" and type(v) == "string" and v ~= "" then out[k] = v end
  end
  return out
end

local function binRecord(folder, parentId)
  return { type = "mp.bin", id = folder:GetUniqueId(), name = folder:GetName(), parent = parentId }
end

local function clipRecord(clip, binId)
  local rcId = clip:GetThirdPartyMetadata("rcId")
  return { type = "mp.clip", id = clip:GetUniqueId(), rcId = type(rcId) == "string" and rcId or "",
    name = clip:GetName(), bin = binId, color = clip:GetClipColor() or "", flags = flagList(clip),
    meta = metaOf(clip), path = clip:GetClipProperty("File Path") or "" }
end

-- Store a record as last seen, so a change the bridge made isn't reported.
local function keepBin(folder, parentId)
  local rec = binRecord(folder, parentId)
  mpBins[rec.id] = { obj = folder, sig = M.jencode(rec) }
  return rec
end

local function keepClip(clip, binId)
  local rec = clipRecord(clip, binId)
  mpClips[rec.id] = { obj = clip, sig = M.jencode(rec), bin = binId }
  return rec
end

local function isTimelineClip(clip)
  local ok, t = pcall(function() return clip:GetClipProperty("Type") end)
  return ok and t == "Timeline"
end

local function scanMediaPool(report)
  local project = pm:GetCurrentProject()
  if not project then return end
  local root = project:GetMediaPool():GetRootFolder()
  local seenBins, seenClips, order = {}, {}, {}
  local function walk(folder, parentId)
    local rec = binRecord(folder, parentId)
    seenBins[rec.id] = true
    local known = mpBins[rec.id]
    local sig = M.jencode(rec)
    if not known or known.sig ~= sig then
      mpBins[rec.id] = { obj = folder, sig = sig }
      if report then emit("EVT", rec) end
    else
      known.obj = folder
    end
    for _, clip in ipairs(folder:GetClipList() or {}) do
      local uid = clip:GetUniqueId()
      if not timelineClips[uid] then
        local kc = mpClips[uid]
        if not kc and isTimelineClip(clip) then
          timelineClips[uid] = true
        elseif not kc or kc.bin ~= rec.id then
          local r = clipRecord(clip, rec.id)
          local s = M.jencode(r)
          if not kc or kc.sig ~= s then
            mpClips[uid] = { obj = clip, sig = s, bin = rec.id }
            if report then emit("EVT", r) end
          end
        else
          kc.obj = clip
        end
        if mpClips[uid] then
          seenClips[uid] = true
          order[#order + 1] = uid
        end
      end
    end
    for _, sub in ipairs(folder:GetSubFolderList() or {}) do walk(sub, rec.id) end
  end
  walk(root, "")
  for id in pairs(mpBins) do
    if not seenBins[id] then
      mpBins[id] = nil
      if report then emit("EVT", { type = "mp.gone", kind = "bin", id = id }) end
    end
  end
  for id in pairs(mpClips) do
    if not seenClips[id] then
      mpClips[id] = nil
      if report then emit("EVT", { type = "mp.gone", kind = "clip", id = id }) end
    end
  end
  -- Names, colours, flags and metadata: a rotating share of clips per scan.
  mpOrder = order
  for _ = 1, math.min(MEDIA_POOL_BUDGET, #mpOrder) do
    if mpCursor > #mpOrder then mpCursor = 1 end
    local kc = mpClips[mpOrder[mpCursor]]
    mpCursor = mpCursor + 1
    local r = clipRecord(kc.obj, kc.bin)
    local s = M.jencode(r)
    if s ~= kc.sig then
      kc.sig = s
      if report then emit("EVT", r) end
    end
  end
end

-- mp.reset with the project, everything as new, then mp.synced.
local function snapshotMediaPool()
  local project = pm:GetCurrentProject()
  mpBins, mpClips, mpOrder, mpCursor = {}, {}, {}, 1
  mpProject = project and project:GetUniqueId()
  emit("EVT", { type = "mp.reset", project = project and { id = project:GetUniqueId(), name = project:GetName() } or nil })
  scanMediaPool(true)
  local bins, clips = 0, 0
  for _ in pairs(mpBins) do bins = bins + 1 end
  for _ in pairs(mpClips) do clips = clips + 1 end
  emit("EVT", { type = "mp.synced", bins = bins, clips = clips,
    project = project and { id = project:GetUniqueId(), name = project:GetName() } or nil })
end

local function bin(id)
  local b = type(id) == "string" and mpBins[id]
  return b and b.obj
end

local function clipOf(id)
  local c = type(id) == "string" and mpClips[id]
  return c and c.obj, c and c.bin
end

local function validName(name)
  return type(name) == "string" and name ~= "" and #name <= 255 and not name:find("%c")
end

-- Sets the given fields, then reads them back.
local function setClipFields(clip, binId, cmd)
  if cmd.name ~= nil then
    if not validName(cmd.name) then return nil, "bad-name" end
    clip:SetName(cmd.name)
  end
  if cmd.color ~= nil then
    if cmd.color == "" then clip:ClearClipColor() else clip:SetClipColor(cmd.color) end
  end
  if cmd.flags ~= nil then
    clip:ClearFlags("All")
    for _, f in ipairs(cmd.flags) do clip:AddFlag(f) end
  end
  if type(cmd.meta) == "table" and next(cmd.meta) then clip:SetMetadata(cmd.meta) end
  if cmd.bin ~= nil and cmd.bin ~= binId then
    local target = bin(cmd.bin)
    if not target then return nil, "unknown-bin" end
    mediaPool():MoveClips({ clip }, target)
    binId = cmd.bin
  end
  local rec = keepClip(clip, clip:GetParentFolder():GetUniqueId())
  if cmd.name ~= nil and rec.name ~= cmd.name then return rec, "readback-name" end
  if cmd.color ~= nil and rec.color ~= cmd.color then return rec, "readback-color" end
  if cmd.bin ~= nil and rec.bin ~= binId then return rec, "readback-bin" end
  if type(cmd.meta) == "table" then
    for k, v in pairs(cmd.meta) do
      if (rec.meta[k] or "") ~= v then return rec, "readback-meta" end
    end
  end
  return rec
end

local function result(rec, err, extra)
  local r = extra or {}
  r.ok = err == nil
  r.error = err
  r.records = rec and { rec } or nil
  return r
end

-- Everything inside a bin, for the "gone" list after deleting it.
local function contents(folder, out)
  out = out or {}
  for _, c in ipairs(folder:GetClipList() or {}) do out[#out + 1] = { kind = "clip", id = c:GetUniqueId() } end
  for _, sub in ipairs(folder:GetSubFolderList() or {}) do
    out[#out + 1] = { kind = "bin", id = sub:GetUniqueId() }
    contents(sub, out)
  end
  return out
end

local function forget(gone)
  for _, g in ipairs(gone) do
    if g.kind == "bin" then mpBins[g.id] = nil else mpClips[g.id] = nil end
  end
end

local handlers = {}

handlers["mp.snapshot"] = function()
  snapshotMediaPool()
  return { ok = true }
end

handlers["mp.bin.create"] = function(cmd)
  local parent = bin(cmd.parent)
  if not parent then return { ok = false, error = "unknown-bin" } end
  if not validName(cmd.name) then return { ok = false, error = "bad-name" } end
  local folder = mediaPool():AddSubFolder(parent, cmd.name)
  if not folder then return { ok = false, error = "create-failed" } end
  local rec = keepBin(folder, cmd.parent)
  return result(rec, rec.name ~= cmd.name and "readback-name" or nil)
end

-- Free has no Folder.SetName: make the new bin, move everything into it, and
-- delete the old one only once it's empty (SPEC §19.1).
handlers["mp.bin.rename"] = function(cmd)
  local old = bin(cmd.id)
  if not old then return { ok = false, error = "unknown-bin" } end
  if not validName(cmd.name) then return { ok = false, error = "bad-name" } end
  local parent = old:GetParentFolder()
  if not parent then return { ok = false, error = "root-bin" } end
  local pool = mediaPool()
  local folder = pool:AddSubFolder(parent, cmd.name)
  if not folder then return { ok = false, error = "create-failed" } end
  local newId = folder:GetUniqueId()
  local clips, subs = old:GetClipList() or {}, old:GetSubFolderList() or {}
  if #clips > 0 then pool:MoveClips(clips, folder) end
  if #subs > 0 then pool:MoveFolders(subs, folder) end
  local records = { keepBin(folder, parent:GetUniqueId()) }
  for _, c in ipairs(folder:GetClipList() or {}) do
    if mpClips[c:GetUniqueId()] then records[#records + 1] = keepClip(c, newId) end
  end
  for _, sub in ipairs(folder:GetSubFolderList() or {}) do records[#records + 1] = keepBin(sub, newId) end
  if #(old:GetClipList() or {}) > 0 or #(old:GetSubFolderList() or {}) > 0 then
    return { ok = false, error = "move-failed", records = records }
  end
  pool:DeleteFolders({ old })
  mpBins[cmd.id] = nil
  return { ok = true, records = records, gone = { { kind = "bin", id = cmd.id } } }
end

handlers["mp.bin.move"] = function(cmd)
  local folder, target = bin(cmd.id), bin(cmd.parent)
  if not folder or not target then return { ok = false, error = "unknown-bin" } end
  mediaPool():MoveFolders({ folder }, target)
  local parent = folder:GetParentFolder()
  local rec = keepBin(folder, parent and parent:GetUniqueId() or "")
  return result(rec, rec.parent ~= cmd.parent and "readback-parent" or nil)
end

handlers["mp.bin.delete"] = function(cmd)
  local folder = bin(cmd.id)
  if not folder then return { ok = true, gone = { { kind = "bin", id = cmd.id } } } end
  if not folder:GetParentFolder() then return { ok = false, error = "root-bin" } end
  local gone = contents(folder)
  gone[#gone + 1] = { kind = "bin", id = cmd.id }
  if not mediaPool():DeleteFolders({ folder }) then return { ok = false, error = "delete-failed" } end
  forget(gone)
  return { ok = true, gone = gone }
end

handlers["mp.clip.import"] = function(cmd)
  local target = bin(cmd.bin)
  if not target then return { ok = false, error = "unknown-bin" } end
  if type(cmd.path) ~= "string" or not bmd.fileexists(cmd.path) then return { ok = false, error = "file-missing" } end
  if type(cmd.rcId) ~= "string" or not cmd.rcId:match("^[0-9a-f]+$") then return { ok = false, error = "bad-id" } end
  local pool = mediaPool()
  local current = pool:GetCurrentFolder()
  pool:SetCurrentFolder(target)
  local items = pool:ImportMedia({ cmd.path }) or {}
  if current then pool:SetCurrentFolder(current) end -- the editor's view stays where it was
  local clip = items[1]
  if not clip then return { ok = false, error = "import-failed" } end
  clip:SetThirdPartyMetadata({ rcId = cmd.rcId })
  local rec, err = setClipFields(clip, cmd.bin, { name = cmd.name, color = cmd.color, flags = cmd.flags, meta = cmd.meta })
  if not err and rec.rcId ~= cmd.rcId then err = "readback-id" end
  return result(rec, err)
end

handlers["mp.clip.link"] = function(cmd)
  local clip, binId = clipOf(cmd.id)
  if not clip then return { ok = false, error = "unknown-clip" } end
  if type(cmd.rcId) ~= "string" or not cmd.rcId:match("^[0-9a-f]+$") then return { ok = false, error = "bad-id" } end
  clip:SetThirdPartyMetadata({ rcId = cmd.rcId })
  local rec = keepClip(clip, binId)
  return result(rec, rec.rcId ~= cmd.rcId and "readback-id" or nil)
end

handlers["mp.clip.set"] = function(cmd)
  local clip, binId = clipOf(cmd.id)
  if not clip then return { ok = false, error = "unknown-clip" } end
  return result(setClipFields(clip, binId, cmd))
end

handlers["mp.clip.delete"] = function(cmd)
  local clip = clipOf(cmd.id)
  local gone = { { kind = "clip", id = cmd.id } }
  if not clip then return { ok = true, gone = gone } end
  if not mediaPool():DeleteClips({ clip }) then return { ok = false, error = "delete-failed" } end
  forget(gone)
  return { ok = true, gone = gone }
end

-- Backups go next to the inbox only: %USERPROFILE%\ResolveCollab\backups\.
local BACKUPS = INBOX:gsub("[\\/][^\\/]+$", "") .. "\\backups\\"

handlers["project.backup"] = function(cmd)
  local path = cmd.path
  if type(path) ~= "string" or path:sub(1, #BACKUPS) ~= BACKUPS or path:find("%.%.") or not path:match("%.drp$") then
    return { ok = false, error = "bad-path" }
  end
  local project = pm:GetCurrentProject()
  if not project then return { ok = false, error = "no-project" } end
  pm:SaveProject()
  return { ok = pm:ExportProject(project:GetName(), path, false) == true, path = path }
end

function handlers.ping()
  return { ok = true }
end

function handlers.stop()
  return { ok = true, stopping = true }
end

-- AppendToTimeline appends to the current timeline, so M2 only applies the
-- clip when the receiver is on a timeline with the same name.
handlers["clip.append"] = function(cmd)
  local tl, project = currentTimeline()
  if not tl then return { ok = false, error = "no-timeline" } end
  if tl:GetName() ~= cmd.timeline then return { ok = false, error = "timeline-not-current", current = tl:GetName() } end
  local mpi = findMedia(project:GetMediaPool():GetRootFolder(), cmd.media and cmd.media.name or "")
  if not mpi then return { ok = false, error = "media-missing" } end
  while tl:GetTrackCount("video") < cmd.track do tl:AddTrack("video") end
  local items = project:GetMediaPool():AppendToTimeline({ { mediaPoolItem = mpi, startFrame = cmd.srcStart,
    endFrame = cmd.srcEnd, trackIndex = cmd.track, recordFrame = cmd.start } }) or {}
  local video
  for _, item in ipairs(items) do
    selfAdded[item:GetUniqueId()] = true
    known[item:GetUniqueId()] = true
    if item:GetTrackTypeAndIndex()[1] == "video" then video = item end
  end
  if not video then return { ok = false, error = "append-failed" } end
  -- Read back: a call can report success without doing what was asked.
  if video:GetStart() ~= cmd.start then
    return { ok = false, error = "readback-mismatch", start = video:GetStart() }
  end
  return { ok = true }
end

local function handle(message)
  local handler = type(message) == "table" and handlers[message.type]
  if not handler then return { ok = false, error = "unknown-command" } end
  local ok, result = pcall(handler, message)
  if not ok then return { ok = false, error = "exception", detail = tostring(result) } end
  return result
end

-- Main loop -------------------------------------------------------------------------

F:SetPrefs(ACTIVE_PREF, bridgeId) -- a newer bridge run takes over from this one
emit("HELLO", { product = R:GetProductName(), version = R:GetVersionString(), studio = R:IsStudio(), inbox = INBOX })
scanTimeline(false)
snapshotMediaPool()

local lastHandled, lastBeat, lastScan, lastPoolScan = 0, 0, 0, 0
while F:GetPrefs(ACTIVE_PREF) == bridgeId do
  bmd.wait(TICK)
  local now = bmd.gettime()
  local stopping = false
  local messages = M.decodeInbox(ms:GetSubFolderList(INBOX) or {}, lastHandled)
  for _, entry in ipairs(messages) do
    lastHandled = entry.seq
    local result = entry.message and handle(entry.message) or { ok = false, error = "bad-message", detail = entry.error }
    result.seq = entry.seq
    emit("RES", result)
    stopping = stopping or result.stopping == true
  end
  if #messages > 0 then emit("ACK", { seq = lastHandled }) end
  if stopping then break end
  if now - lastScan >= SNAPSHOT_EVERY then
    lastScan = now
    local ok, err = pcall(scanTimeline, true)
    if not ok then emit("ERR", { error = "scan-failed", detail = tostring(err) }) end
  end
  if now - lastPoolScan >= MEDIA_POOL_EVERY then
    lastPoolScan = now
    local project = pm:GetCurrentProject()
    local ok, err = pcall(function()
      -- Another project open: report it whole, and the companion pauses (SPEC §9.2).
      if project and project:GetUniqueId() ~= mpProject then snapshotMediaPool() else scanMediaPool(true) end
    end)
    if not ok then emit("ERR", { error = "media-pool-scan-failed", detail = tostring(err) }) end
  end
  if now - lastBeat >= HEARTBEAT_EVERY then
    lastBeat = now
    emit("HB", { t = now, handled = lastHandled })
  end
end
emit("ERR", { error = "bridge-stopped" })
