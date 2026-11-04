-- ResolveCollab bridge (SPEC §3, §18, §19, §20). Runs inside DaVinci Resolve from
-- Workspace > Scripts > ResolveCollab and talks to the companion app:
--   out: errors raised through fusion:Execute, which Resolve writes to
--        Support/logs/ResolveDebug.txt as  RC|<bridgeId>|<kind>|<hex(JSON)>,
--        long messages split across lines ending |<part>/<parts>/<msgId>
--   in:  subfolders of the inbox named  <seq:8>.<part:3>.<parts:3>.<hex(JSON)>,
--        listed with MediaStorage:GetSubFolderList (Free has no file reads),
--        but only once <seq:8>.ready exists for the next message: listing
--        makes the Media Storage browser jump and empties the Metadata panel.
-- Inbound text is only ever parsed as JSON by jdecode below, never executed.

-- Tests load this file with loadfile(path)("test") to get the pure helpers.
local MODE = ...

local INBOX = [[__INBOX__]]
-- A hash of this file, stamped by tools/install-bridge.ts (src/bridge/bridge-build.ts).
local BUILD = [[__BUILD__]]
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

-- Folder the companion creates once message seq is complete.
function M.readyName(seq)
  return string.format("%08d.ready", seq)
end

-- Timelines: pure helpers -----------------------------------------------------------

-- Timecode of a frame offset from a timeline's start timecode (non-drop,
-- nominal rate: 23.976 counts as 24).
function M.timecode(offset, fps, startTc)
  local rate = math.floor((tonumber(fps) or 24) + 0.5)
  local h, m, s, f = tostring(startTc or "01:00:00:00"):match("^(%d+)[:;](%d+)[:;](%d+)[:;](%d+)$")
  local start = h and (((tonumber(h) * 60 + tonumber(m)) * 60 + tonumber(s)) * rate + tonumber(f)) or 0
  local total = start + math.floor(offset)
  local frames = total % rate
  local secs = math.floor(total / rate)
  return string.format("%02d:%02d:%02d:%02d", math.floor(secs / 3600), math.floor(secs / 60) % 60, secs % 60, frames)
end

-- Basic titles from Effects > Titles report GetType() "generator" like real
-- generators; they are told apart by name.
local BASIC_TITLES = { ["Text"] = true, ["Scroll"] = true, ["Left Lower Third"] = true, ["Middle Lower Third"] = true, ["Right Lower Third"] = true }
-- Media pool types a timeline clip can't be synced as (SPEC §20.2).
local UNSUPPORTED_MEDIA = { ["Compound"] = true, ["Timeline"] = true, ["Multicam"] = true, ["Fusion Composition"] = true }

-- What kind of item this is, from facts the runtime reads.
function M.itemKind(facts)
  if facts.type == "transition" then return "transition" end
  if facts.mediaType then return UNSUPPORTED_MEDIA[facts.mediaType] and "other" or "clip" end
  if facts.type == "generator" then return BASIC_TITLES[facts.name] and "title" or "generator" end
  if facts.textPlus then return "textplus" end
  return "other"
end

-- An item's ID and where it sits from the timeline's start. While an item is
-- being dropped Resolve reports no start or length for a moment: then only
-- the ID (or nothing, if even that can't be read).
function M.placeOf(item, base)
  local okId, uid = pcall(function() return item:GetUniqueId() end)
  if not okId or type(uid) ~= "string" then return nil end
  local ok, start, duration = pcall(function() return item:GetStart(), item:GetDuration() end)
  if not ok or type(start) ~= "number" or type(duration) ~= "number" then return uid end
  return uid, start - base, duration
end

-- The synced properties out of GetProperties, or nil when Resolve returned
-- none of them (it does for a moment after a drop).
function M.pickProps(raw, keys)
  if type(raw) ~= "table" then return nil end
  local out, any = {}, false
  for key, v in pairs(raw) do
    if keys[key] and (type(v) == "number" or type(v) == "boolean") then out[key], any = v, true end
  end
  return any and out or nil
end

-- GetMarkers() (frame → info) as a list sorted by frame; `tag` is the
-- marker's customData (SPEC §21.4).
function M.markerList(raw)
  local out = {}
  for frame, m in pairs(type(raw) == "table" and raw or {}) do
    if type(frame) == "number" and type(m) == "table" then
      out[#out + 1] = { frame = frame, duration = tonumber(m.duration) or 1, color = tostring(m.color or ""),
        name = tostring(m.name or ""), note = tostring(m.note or ""), tag = tostring(m.customData or "") }
    end
  end
  table.sort(out, function(a, b) return a.frame < b.frame end)
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
    meta = metaOf(clip), path = clip:GetClipProperty("File Path") or "", markers = M.markerList(clip:GetMarkers()) }
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

-- Resolve keeps running this loop while it loads another project, so the
-- project can change in the middle of a walk. Findings are held back and
-- reported only if the project was the same before and after; otherwise
-- nothing is reported and the next loop takes a fresh snapshot. (Reporting
-- them once made another project's bins look like local edits and this
-- project's clips look deleted.)
local function scanMediaPool(report)
  local project = pm:GetCurrentProject()
  if not project or project:GetUniqueId() ~= mpProject then return false end
  local out = {}
  local function found(rec) if report then out[#out + 1] = rec end end
  local root = project:GetMediaPool():GetRootFolder()
  local seenBins, seenClips, order = {}, {}, {}
  local function walk(folder, parentId)
    local rec = binRecord(folder, parentId)
    seenBins[rec.id] = true
    local known = mpBins[rec.id]
    local sig = M.jencode(rec)
    if not known or known.sig ~= sig then
      mpBins[rec.id] = { obj = folder, sig = sig }
      found(rec)
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
            found(r)
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
      found({ type = "mp.gone", kind = "bin", id = id })
    end
  end
  for id in pairs(mpClips) do
    if not seenClips[id] then
      mpClips[id] = nil
      found({ type = "mp.gone", kind = "clip", id = id })
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
      found(r)
    end
  end
  local now = pm:GetCurrentProject()
  if not now or now:GetUniqueId() ~= mpProject then
    -- Switched while walking: what was read may belong to either project.
    mpBins, mpClips, mpOrder, mpCursor, mpProject = {}, {}, {}, 1, nil
    return false
  end
  for _, rec in ipairs(out) do emit("EVT", rec) end
  return true
end

-- mp.reset with the project, everything as new, then mp.synced.
local function snapshotMediaPool()
  local project = pm:GetCurrentProject()
  mpBins, mpClips, mpOrder, mpCursor = {}, {}, {}, 1
  mpProject = project and project:GetUniqueId()
  emit("EVT", { type = "mp.reset", project = project and { id = project:GetUniqueId(), name = project:GetName() } or nil })
  -- A switch during the walk: the next loop snapshots again.
  if project and not scanMediaPool(true) then return end
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

-- Timelines (SPEC §20.4) ---------------------------------------------------------------
-- The timeline list every scan; the current timeline's tracks and items:
-- positions of all items every scan (cheap), full records for new or moved
-- items and a rotating share of the rest. Item records use frames from the
-- timeline start and local IDs; the companion maps them to the session.

local TL_BUDGET = 40 -- existing items fully re-read per scan
local SETTINGS_EVERY = 5 -- seconds between re-reading a timeline's settings
local PROP_KEYS = {}
for _, k in ipairs({ "AnchorPointX", "AnchorPointY", "CompositeEnabled", "CompositeMode", "CropBottom", "CropLeft", "CropRetain", "CropRight",
  "CropSoftness", "CropTop", "CroppingEnabled", "Distortion", "DynamicZoomEase", "DynamicZoomEnabled", "FlipX", "FlipY",
  "LensCorrectionEnabled", "MotionEstimation", "Opacity", "Pan", "Pitch", "ResizeFilter", "RetimeAndScalingEnabled",
  "RetimeProcess", "RotationAngle", "Scaling", "Tilt", "TransformEnabled", "Yaw", "ZoomGang", "ZoomX", "ZoomY" }) do PROP_KEYS[k] = true end

local tlListSig, tlCurrent, tlTracksSig = nil, nil, nil
local tlItems, tlOrder, tlCursor = {}, {}, 1 -- current timeline: uid → { obj, light, sig }
local tlSettings = {} -- timeline uid → { at, fps, width, height }
local SETTLE = 1.0 -- seconds the user's timeline edits must be still before they're reported
local tlLastChange, tlHeld, tlHeldGone, tlHeldTracks = 0, {}, {}, false
-- Items Resolve can't fully read yet (uid → since when) hold the settle wait
-- for at most UNREAD_WAIT seconds; tlUnsure: since when an item's ID can't be read.
local UNREAD_WAIT = 3.0
local tlUnread, tlUnsure = {}, nil
-- Items this bridge's own commands just changed (and their linked items):
-- their changes are reported like any other but aren't the user editing.
local OWN = 2.0
local tlOwn = {}
-- The current timeline's own markers: frame → last reported encoding;
-- frames changed or gone since, held like items; when a command last
-- changed them.
local tlMarkers, tlHeldMarkers, tlMarkersOwn = {}, {}, 0

local function project() return pm:GetCurrentProject() end

local function timelines()
  local p = project()
  local out = {}
  if not p then return out end
  for i = 1, p:GetTimelineCount() or 0 do out[#out + 1] = p:GetTimelineByIndex(i) end
  return out
end

local function timelineById(id)
  for _, t in ipairs(timelines()) do if t:GetUniqueId() == id then return t end end
end

local function settingsOf(tl)
  local id = tl:GetUniqueId()
  local s = tlSettings[id]
  if not s or bmd.gettime() - s.at > SETTINGS_EVERY then
    local all = tl:GetSettings() or {}
    s = { at = bmd.gettime(), fps = tonumber(all.timelineFrameRate) or 24, width = tonumber(all.timelineResolutionWidth) or 1920,
      height = tonumber(all.timelineResolutionHeight) or 1080 }
    tlSettings[id] = s
  end
  return s
end

local function rcIdOf(tl)
  local mpi = tl:GetMediaPoolItem()
  local rc = mpi and mpi:GetThirdPartyMetadata("rcId")
  return type(rc) == "string" and rc or ""
end

local function listRecord()
  local p = project()
  local cur = p and p:GetCurrentTimeline()
  local list = {}
  for _, t in ipairs(timelines()) do
    local s = settingsOf(t)
    list[#list + 1] = { id = t:GetUniqueId(), rcId = rcIdOf(t), name = t:GetName(), fps = s.fps, width = s.width, height = s.height }
  end
  return { type = "tl.list", project = p and p:GetUniqueId() or "", timelines = list, current = cur and cur:GetUniqueId() or "" }
end

local function textPlusTool(item)
  local ok, comp = pcall(function() return item:GetFusionCompByIndex(1) end)
  if not ok or not comp then return nil, nil end
  local tool = (comp:GetToolList(false, "TextPlus") or {})[1]
  return tool, comp
end

local function trackRecord(tl)
  local rec = { type = "tl.tracks", timeline = tl:GetUniqueId(), video = {}, audio = {} }
  for _, kind in ipairs({ "video", "audio" }) do
    for i = 1, tl:GetTrackCount(kind) or 0 do
      rec[kind][i] = { name = tl:GetTrackName(kind, i) or "", enabled = tl:GetIsTrackEnabled(kind, i) == true,
        locked = tl:GetIsTrackLocked(kind, i) == true, subType = kind == "audio" and (tl:GetTrackSubType(kind, i) or "") or "" }
    end
  end
  return rec
end

-- nil while Resolve can't fully read the item yet (SPEC §20.4).
local function itemRecord(tl, item, kind, index)
  local uid, start, duration = M.placeOf(item, tl:GetStartFrame())
  if not start then return nil end
  local mpi = item:GetMediaPoolItem()
  local typ = item:GetType()
  local tool = (not mpi and typ == "video") and textPlusTool(item) or nil
  local k = M.itemKind({ type = typ, name = item:GetName(), mediaType = mpi and (mpi:GetClipProperty("Type") or "") or nil, textPlus = tool ~= nil })
  local rec = { type = "tl.item", timeline = tl:GetUniqueId(), id = uid, kind = k, trackKind = kind, trackIndex = index,
    start = start, duration = duration, enabled = item:GetClipEnabled() ~= false,
    color = item:GetClipColor() or "", name = item:GetName() or "", media = mpi and mpi:GetUniqueId() or "", linked = {} }
  if k == "clip" then
    rec.srcStart = item:GetLeftOffset() or 0
    local speed = item:GetSpeed()
    rec.speed = type(speed) == "table" and speed.Percentage or 100
    for _, l in ipairs(item:GetLinkedItems() or {}) do rec.linked[#rec.linked + 1] = l:GetUniqueId() end
  end
  if k == "clip" or k == "textplus" then
    local fades = item:GetFades() or {}
    rec.fadeIn, rec.fadeOut = fades.FadeIn or 0, fades.FadeOut or 0
  end
  if (k == "clip" and kind == "video") or k == "textplus" then
    rec.props = M.pickProps(item:GetProperties(), PROP_KEYS)
    if not rec.props then return nil end
  end
  if k == "title" or k == "generator" or k == "textplus" then rec.template = item:GetName() or "" end
  if k == "textplus" then
    rec.text = { styled = tostring(tool:GetInput("StyledText") or ""), font = tostring(tool:GetInput("Font") or ""),
      style = tostring(tool:GetInput("Style") or ""), size = tonumber(tool:GetInput("Size")) or 0 }
  end
  if k == "transition" then
    rec.template = item:GetProperty("TransitionType") or item:GetName() or ""
    rec.alignment = string.lower(tostring(item:GetProperty("TransitionAlignment") or "center"))
  else
    local ok, raw = pcall(function() return item:GetMarkers() end)
    rec.markers = M.markerList(ok and raw or nil)
  end
  return rec
end

local function markerRecord(timeline, m)
  return { type = "tl.marker", timeline = timeline, frame = m.frame, duration = m.duration, color = m.color, name = m.name, note = m.note, tag = m.tag }
end

local function keepItem(tl, item, kind, index)
  local rec = itemRecord(tl, item, kind, index)
  if not rec then return nil end
  local light = rec.start .. ":" .. rec.duration .. ":" .. kind .. index
  local sig = M.jencode(rec)
  tlItems[rec.id] = { obj = item, light = light, sig = sig, seen = sig, kind = kind, index = index }
  tlHeld[rec.id] = nil
  return rec
end

-- Like the media pool scan: held back, and dropped if the project changed
-- during the scan.
--
-- The user's own changes are reported once the timeline has been still for
-- SETTLE seconds: a clip being dragged already shows on the timeline before
-- it is dropped, and reporting (and then editing around) that half-made
-- change crashed Resolve. Until then, commands that edit the open timeline
-- answer "user-editing" and the companion tries again shortly.
local function scanTimelines(full)
  local p0 = project()
  local before = p0 and p0:GetUniqueId() or ""
  local out = {}
  local function found(rec) out[#out + 1] = rec end
  local function flush()
    local p1 = project()
    if (p1 and p1:GetUniqueId() or "") ~= before then
      tlListSig, tlCurrent = nil, nil
      return
    end
    for _, rec in ipairs(out) do emit("EVT", rec) end
  end
  local list = listRecord()
  local sig = M.jencode(list)
  if sig ~= tlListSig then
    tlListSig = sig
    found(list)
  end
  local p = project()
  local tl = p and p:GetCurrentTimeline()
  if not tl then
    tlCurrent = nil
    return flush()
  end
  local id = tl:GetUniqueId()
  if id ~= tlCurrent or full then
    tlCurrent, tlTracksSig, tlItems, tlOrder, tlCursor, full = id, nil, {}, {}, 1, true
    tlHeld, tlHeldGone, tlHeldTracks, tlUnread, tlUnsure = {}, {}, false, {}, nil
    tlMarkers, tlHeldMarkers = {}, {}
    found({ type = "tl.reset", timeline = id })
  end
  local now = bmd.gettime()
  local changed = false
  local function mine(uid) return tlOwn[uid] and now - tlOwn[uid] < OWN end
  local tracks = trackRecord(tl)
  local tsig = M.jencode(tracks)
  if tsig ~= tlTracksSig then
    tlTracksSig = tsig
    if full then found(tracks) else tlHeldTracks, changed = true, true end
  end
  local base = tl:GetStartFrame()
  local seen, order = {}, {}
  -- An item Resolve can't fully read yet (one being dropped) is still
  -- moving: it's held, and holds the settle wait for up to UNREAD_WAIT.
  local function unread(uid)
    tlHeld[uid] = true
    tlUnread[uid] = tlUnread[uid] or now
    if now - tlUnread[uid] < UNREAD_WAIT then changed = true end
  end
  local unsure = false
  for _, kind in ipairs({ "video", "audio" }) do
    for index = 1, tl:GetTrackCount(kind) or 0 do
      for _, item in ipairs(tl:GetItemListInTrack(kind, index) or {}) do
        local uid, start, duration = M.placeOf(item, base)
        local known = uid and tlItems[uid]
        local light = start and (start .. ":" .. duration .. ":" .. kind .. index)
        if not uid then
          unsure = true
        elseif not start then
          if known then known.obj, known.light = item, ""
          else tlItems[uid] = { obj = item, light = "", sig = "", kind = kind, index = index } end
          unread(uid)
        elseif full and (not known or known.light ~= light) then
          local rec = itemRecord(tl, item, kind, index)
          if rec then
            local s = M.jencode(rec)
            if not known or known.sig ~= s then found(rec) end
            tlItems[uid] = { obj = item, light = light, sig = s, seen = s, kind = kind, index = index }
            tlUnread[uid] = nil
          else
            tlItems[uid] = { obj = item, light = light, sig = "", kind = kind, index = index }
            unread(uid)
          end
        elseif not known or known.light ~= light then
          tlItems[uid] = { obj = item, light = light, sig = known and known.sig or "", kind = kind, index = index }
          tlHeld[uid], tlHeldGone[uid] = true, nil
          if not mine(uid) then changed = true end
        else
          known.obj = item
        end
        if uid then
          seen[uid] = true
          order[#order + 1] = uid
        end
      end
    end
  end
  -- An item whose ID can't be read might be any of them: nothing is taken
  -- as deleted this time.
  if unsure then
    tlUnsure = tlUnsure or now
    if now - tlUnsure < UNREAD_WAIT then changed = true end
  else
    tlUnsure = nil
    for uid, k in pairs(tlItems) do
      if not seen[uid] then
        tlItems[uid], tlHeld[uid], tlUnread[uid] = nil, nil, nil
        if full then found({ type = "tl.gone", timeline = id, id = uid })
        -- (never reported: nothing to take back)
        elseif k.sig ~= "" then
          tlHeldGone[uid] = true
          if not mine(uid) then changed = true end
        end
      end
    end
  end
  -- What our own commands changed is read again now rather than waiting for
  -- its turn below, which would count it as the user's.
  for uid, at in pairs(tlOwn) do
    local k = tlItems[uid]
    if k and not tlHeld[uid] and now - at < OWN then
      local rec = itemRecord(tl, k.obj, k.kind, k.index)
      local s = rec and M.jencode(rec)
      if not s then tlHeld[uid] = true
      elseif s ~= (k.seen or k.sig) then k.seen, tlHeld[uid] = s, true end
    end
    if now - at >= OWN or k then tlOwn[uid] = nil end
  end
  -- Names, colours, properties, fades and text: a rotating share of items.
  tlOrder = order
  for _ = 1, math.min(TL_BUDGET, #tlOrder) do
    if tlCursor > #tlOrder then tlCursor = 1 end
    local uid = tlOrder[tlCursor]
    local k = tlItems[uid]
    tlCursor = tlCursor + 1
    if not tlHeld[uid] then
      local rec = itemRecord(tl, k.obj, k.kind, k.index)
      if not rec then unread(uid)
      else
        local s = M.jencode(rec)
        if s ~= (k.seen or k.sig) then
          k.seen = s
          tlHeld[uid], changed = true, true
        end
      end
    end
  end
  -- The timeline's own markers, every scan (cheap: SPEC §21.1). Like items,
  -- the user's changes are held until the timeline is still; the bridge's
  -- own (tlMarkersOwn) are reported the same way but aren't the user editing.
  local markersNow = {}
  for _, m in ipairs(M.markerList(tl:GetMarkers())) do
    local rec = markerRecord(id, m)
    markersNow[m.frame] = { rec = rec, sig = M.jencode(rec) }
  end
  local ownMarkers = now - tlMarkersOwn < OWN
  for frame, m in pairs(markersNow) do
    if tlMarkers[frame] ~= m.sig then
      tlMarkers[frame] = m.sig
      if full then found(m.rec)
      else
        tlHeldMarkers[frame] = true
        if not ownMarkers then changed = true end
      end
    end
  end
  for frame in pairs(tlMarkers) do
    if not markersNow[frame] then
      tlMarkers[frame] = nil
      if not full then
        tlHeldMarkers[frame] = true
        if not ownMarkers then changed = true end
      end
    end
  end
  if changed then tlLastChange = now end
  if not full and now - tlLastChange >= SETTLE then
    if tlHeldTracks then found(tracks) end
    for uid in pairs(tlHeldGone) do found({ type = "tl.gone", timeline = id, id = uid }) end
    for frame in pairs(tlHeldMarkers) do
      local m = markersNow[frame]
      found(m and m.rec or { type = "tl.marker.gone", timeline = id, frame = frame })
    end
    tlHeldMarkers = {}
    local still = {}
    for uid in pairs(tlHeld) do
      local k = tlItems[uid]
      local rec = k and itemRecord(tl, k.obj, k.kind, k.index)
      if k and not rec then still[uid] = true
      elseif rec then
        tlUnread[uid] = nil
        local s = M.jencode(rec)
        k.seen = s
        if s ~= k.sig then
          k.sig = s
          found(rec)
        end
      end
    end
    tlHeld, tlHeldGone, tlHeldTracks = still, {}, false
  end
  if full then found({ type = "tl.synced", timeline = id }) end
  flush()
end

-- Timeline commands -------------------------------------------------------------------

local function currentFor(cmd)
  local p = project()
  local tl = p and p:GetCurrentTimeline()
  if not tl then return nil, "no-timeline" end
  if tl:GetUniqueId() ~= cmd.timeline then return nil, "not-current" end
  -- Never edit the timeline while the user's own change is still moving.
  if bmd.gettime() - tlLastChange < SETTLE then return nil, "user-editing" end
  return tl
end

-- An item Resolve has removed since the last scan reads as nil.
local function itemOf(id)
  local k = type(id) == "string" and tlItems[id]
  if not k then return nil end
  local ok, start = pcall(function() return k.obj:GetStart() end)
  if not ok or start == nil then
    tlItems[id] = nil
    return nil
  end
  return k.obj
end

-- True if anything but a transition sits in [start, start + duration).
local function occupied(tl, kind, index, start, duration)
  local base = tl:GetStartFrame()
  for _, it in ipairs(tl:GetItemListInTrack(kind, index) or {}) do
    if it:GetType() ~= "transition" then
      local s = it:GetStart() - base
      if s < start + duration and start < s + it:GetDuration() then return true end
    end
  end
  return false
end

-- Files for timeline swaps live under the ResolveCollab folder only.
local HOME = INBOX:gsub("[\\/][^\\/]+$", "") .. "\\"
local function safeDrt(path)
  return type(path) == "string" and path:sub(1, #HOME) == HOME and not path:find("%.%.") and path:match("%.drt$") ~= nil
end

-- Puts the playhead back after an append or insert moved it.
local function withPlayhead(tl, fn)
  local tc = tl:GetCurrentTimecode()
  local a, b = fn()
  if tc then tl:SetCurrentTimecode(tc) end
  return a, b
end

local function settingsFor(cmd)
  local s = { useCustomSettings = "1" }
  if cmd.fps then s.timelineFrameRate = tostring(cmd.fps) end
  if cmd.width then s.timelineResolutionWidth = tostring(cmd.width) end
  if cmd.height then s.timelineResolutionHeight = tostring(cmd.height) end
  return s
end

handlers["tl.create"] = function(cmd)
  if not validName(cmd.name) then return { ok = false, error = "bad-name" } end
  local p = project()
  local before = p:GetCurrentTimeline()
  local tl = mediaPool():CreateEmptyTimeline(cmd.name)
  if not tl then return { ok = false, error = "create-failed" } end
  tl:SetSettings(settingsFor(cmd))
  local mpi = tl:GetMediaPoolItem()
  if mpi then mpi:SetThirdPartyMetadata({ rcId = cmd.rcId }) end
  -- Creating a timeline makes it current; the user's view is put back.
  if before then p:SetCurrentTimeline(before) end
  tlSettings[tl:GetUniqueId()] = nil
  return { ok = true, id = tl:GetUniqueId() }
end

handlers["tl.link"] = function(cmd)
  local tl = timelineById(cmd.id)
  local mpi = tl and tl:GetMediaPoolItem()
  if not mpi then return { ok = false, error = "unknown-timeline" } end
  mpi:SetThirdPartyMetadata({ rcId = cmd.rcId })
  return { ok = mpi:GetThirdPartyMetadata("rcId") == cmd.rcId }
end

handlers["tl.set"] = function(cmd)
  local tl = timelineById(cmd.id)
  if not tl then return { ok = false, error = "unknown-timeline" } end
  if cmd.name ~= nil then
    if not validName(cmd.name) then return { ok = false, error = "bad-name" } end
    tl:SetName(cmd.name)
  end
  if cmd.fps or cmd.width or cmd.height then tl:SetSettings(settingsFor(cmd)) end
  tlSettings[cmd.id] = nil
  if cmd.name ~= nil and tl:GetName() ~= cmd.name then return { ok = false, error = "readback-name" } end
  return { ok = true }
end

handlers["tl.delete"] = function(cmd)
  local tl = timelineById(cmd.id)
  if not tl then return { ok = true } end
  return { ok = mediaPool():DeleteTimelines({ tl }) == true }
end

handlers["tl.export"] = function(cmd)
  if not safeDrt(cmd.path) then return { ok = false, error = "bad-path" } end
  local tl = timelineById(cmd.id)
  if not tl then return { ok = false, error = "unknown-timeline" } end
  return { ok = tl:Export(cmd.path, R.EXPORT_DRT, R.EXPORT_NONE) == true }
end

-- Tier 3 (SPEC §20.6): replace a timeline with an imported copy, keeping its
-- name, collab ID, and the user's current timeline and playhead.
handlers["tl.swap"] = function(cmd)
  if not safeDrt(cmd.path) or not validName(cmd.name) then return { ok = false, error = "bad-path" } end
  local p = project()
  local old = timelineById(cmd.id)
  if not old then return { ok = false, error = "unknown-timeline" } end
  local before = p:GetCurrentTimeline()
  local wasCurrent = before and before:GetUniqueId() == cmd.id
  local tc = wasCurrent and before:GetCurrentTimecode() or nil
  local fresh = mediaPool():ImportTimelineFromFile(cmd.path, { importSourceClips = false })
  if not fresh then return { ok = false, error = "import-failed" } end
  if not mediaPool():DeleteTimelines({ old }) then
    mediaPool():DeleteTimelines({ fresh })
    return { ok = false, error = "delete-failed" }
  end
  fresh:SetName(cmd.name)
  local mpi = fresh:GetMediaPoolItem()
  if mpi then mpi:SetThirdPartyMetadata({ rcId = cmd.rcId }) end
  if wasCurrent then
    p:SetCurrentTimeline(fresh)
    if tc then fresh:SetCurrentTimecode(tc) end
  elseif before then
    p:SetCurrentTimeline(before)
  end
  return { ok = true, id = fresh:GetUniqueId() }
end

handlers["track.add"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local kind = cmd.kind == "audio" and "audio" or "video"
  local subType = kind == "audio" and cmd.subType ~= "" and cmd.subType or nil
  if not tl:AddTrack(kind, subType) then return { ok = false, error = "add-failed" } end
  local index = tl:GetTrackCount(kind)
  if type(cmd.name) == "string" and cmd.name ~= "" then tl:SetTrackName(kind, index, cmd.name) end
  if cmd.enabled == false then tl:SetTrackEnable(kind, index, false) end
  if cmd.locked == true then tl:SetTrackLock(kind, index, true) end
  local tracks = trackRecord(tl)
  tlTracksSig = M.jencode(tracks)
  return { ok = true, tracks = tracks }
end

handlers["track.set"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local kind = cmd.kind == "audio" and "audio" or "video"
  local index = tonumber(cmd.index)
  if not index or index < 1 or index > (tl:GetTrackCount(kind) or 0) then return { ok = false, error = "unknown-track" } end
  if type(cmd.name) == "string" and cmd.name ~= "" then tl:SetTrackName(kind, index, cmd.name) end
  if cmd.enabled ~= nil then tl:SetTrackEnable(kind, index, cmd.enabled == true) end
  if cmd.locked ~= nil then tl:SetTrackLock(kind, index, cmd.locked == true) end
  local tracks = trackRecord(tl)
  tlTracksSig = M.jencode(tracks)
  return { ok = true, tracks = tracks }
end

handlers["track.delete"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local kind = cmd.kind == "audio" and "audio" or "video"
  local index = tonumber(cmd.index)
  if not index or index < 1 or index > (tl:GetTrackCount(kind) or 0) then return { ok = false, error = "unknown-track" } end
  local gone = {}
  for _, item in ipairs(tl:GetItemListInTrack(kind, index) or {}) do gone[#gone + 1] = item:GetUniqueId() end
  -- Resolve won't delete a locked track.
  if tl:GetIsTrackLocked(kind, index) then tl:SetTrackLock(kind, index, false) end
  if not tl:DeleteTrack(kind, index) then return { ok = false, error = "delete-failed" } end
  for _, uid in ipairs(gone) do tlItems[uid] = nil end
  -- Items on the tracks above moved down one place.
  for _, k in pairs(tlItems) do
    if k.kind == kind and k.index > index then k.index = k.index - 1 end
  end
  local tracks = trackRecord(tl)
  tlTracksSig = M.jencode(tracks)
  return { ok = true, gone = gone, tracks = tracks }
end

-- Fields every item kind takes after it exists; read back by the caller.
local function setCommon(item, cmd)
  if cmd.enabled ~= nil then item:SetClipEnabled(cmd.enabled == true) end
  if cmd.color ~= nil then
    if cmd.color == "" then item:ClearClipColor() else item:SetClipColor(cmd.color) end
  end
  if type(cmd.name) == "string" and cmd.name ~= "" and cmd.name ~= item:GetName() then item:SetName(cmd.name) end
  if type(cmd.props) == "table" then
    local props = {}
    for k, v in pairs(cmd.props) do if PROP_KEYS[k] then props[k] = v end end
    if next(props) then item:SetProperties(props) end
  end
  if cmd.speed ~= nil and tonumber(cmd.speed) and tonumber(cmd.speed) ~= 100 then item:SetSpeed({ Percentage = tonumber(cmd.speed) }) end
  if cmd.fadeIn ~= nil or cmd.fadeOut ~= nil then
    local f = item:GetFades() or {}
    item:SetFades({ FadeIn = tonumber(cmd.fadeIn) or f.FadeIn or 0, FadeOut = tonumber(cmd.fadeOut) or f.FadeOut or 0 })
  end
  if type(cmd.text) == "table" then
    local tool, comp = textPlusTool(item)
    if tool then
      comp:Lock()
      if type(cmd.text.styled) == "string" then tool:SetInput("StyledText", cmd.text.styled) end
      if type(cmd.text.font) == "string" and cmd.text.font ~= "" then tool:SetInput("Font", cmd.text.font) end
      if type(cmd.text.style) == "string" and cmd.text.style ~= "" then tool:SetInput("Style", cmd.text.style) end
      if tonumber(cmd.text.size) then tool:SetInput("Size", tonumber(cmd.text.size)) end
      comp:Unlock()
    end
  end
end

-- Titles and generators are insert edits that ripple; past the end of the
-- timeline nothing moves. The In/Out marks give the length (SPEC §20.1).
local function insertGenerated(tl, cmd)
  local s = settingsOf(tl)
  local base = tl:GetStartFrame()
  local userMarks = tl:GetMarkInOut()
  local markIn = tl:GetEndFrame() - base + 48
  tl:SetMarkInOut(markIn, markIn + tonumber(cmd.duration) - 1)
  tl:SetCurrentTimecode(M.timecode(markIn, s.fps, tl:GetStartTimecode()))
  local template = type(cmd.template) == "string" and cmd.template ~= "" and cmd.template or nil
  local item
  if cmd.kind == "title" then item = tl:InsertTitleIntoTimeline(template or "Text")
  elseif cmd.kind == "textplus" then item = tl:InsertFusionTitleIntoTimeline(template or "Text+")
  else
    item = tl:InsertGeneratorIntoTimeline(template or "Solid Color") or tl:InsertFusionGeneratorIntoTimeline(template or "")
      or tl:InsertOFXGeneratorIntoTimeline(template or "")
  end
  tl:ClearMarkInOut()
  local v = userMarks and userMarks.video
  if v and v["in"] then tl:SetMarkInOut(v["in"], v["out"]) end
  if not item then return nil end
  item:SetPosition({ startFrame = base + tonumber(cmd.start), trackIndex = tonumber(cmd.trackIndex) })
  return item
end

handlers["item.add"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local kind = cmd.trackKind == "audio" and "audio" or "video"
  local index = tonumber(cmd.trackIndex)
  if not index or index < 1 or index > (tl:GetTrackCount(kind) or 0) then return { ok = false, error = "unknown-track" } end
  local start, duration = tonumber(cmd.start), tonumber(cmd.duration)
  if not start or not duration or duration < 1 then return { ok = false, error = "bad-range" } end
  local base = tl:GetStartFrame()
  -- Adding onto occupied space is never right here (and adding onto a clip
  -- the user was dragging crashed Resolve).
  if cmd.kind ~= "transition" and occupied(tl, kind, index, start, duration) then return { ok = false, error = "occupied" } end
  local item
  if cmd.kind == "clip" then
    local mpi = clipOf(cmd.media)
    if not mpi then return { ok = false, error = "media-missing" } end
    -- Offsets and lengths are in timeline frames; AppendToTimeline takes
    -- source frames, which differ when the clip's frame rate does.
    local ratio = (tonumber(mpi:GetClipProperty("FPS")) or settingsOf(tl).fps) / settingsOf(tl).fps
    local src = tonumber(cmd.srcStart) or 0
    local items = withPlayhead(tl, function()
      return mediaPool():AppendToTimeline({ { mediaPoolItem = mpi, startFrame = math.floor(src * ratio + 0.5),
        endFrame = math.floor((src + duration) * ratio + 0.5), mediaType = kind == "video" and 1 or 2, trackIndex = index, recordFrame = base + start } })
    end) or {}
    item = items[1]
    -- Rounding between frame rates can leave it a frame off.
    if item and item:GetDuration() ~= duration and item:GetRightOffset() ~= nil then
      item:SetRightOffset(item:GetRightOffset() + item:GetDuration() - duration)
    end
  elseif cmd.kind == "transition" then
    local edge = type(cmd.edge) == "table" and itemOf(cmd.edge.item)
    if not edge then return { ok = false, error = "edge-missing" } end
    local position = cmd.edge.side == "end" and "end" or "start"
    -- AddTransition needs the right category; the session only knows the name.
    for _, category in ipairs({ "simple", "fusion", "ofx", "audio" }) do
      item = edge:AddTransition({ type = cmd.template, category = category, position = position, alignment = cmd.edge.alignment, duration = duration })
      if item then break end
    end
  else
    item = withPlayhead(tl, function() return insertGenerated(tl, cmd) end)
  end
  if not item then return { ok = false, error = "add-failed" } end
  -- Resolve copied the pool clip's markers onto it; the session says which
  -- markers it has (SPEC §21.3).
  if cmd.kind == "clip" then item:DeleteMarkersByColor("All") end
  if cmd.kind ~= "transition" then setCommon(item, cmd) end
  local rec = keepItem(tl, item, kind, index)
  if not rec then
    if cmd.kind ~= "transition" then tl:DeleteClips({ item }, false) end
    return { ok = false, error = "unreadable" }
  end
  -- Read back. What came out wrong is removed again, so a retry can't pile
  -- up copies.
  if cmd.kind ~= "transition" and (rec.start ~= start or rec.duration ~= duration) then
    tl:DeleteClips({ item }, false)
    tlItems[rec.id] = nil
    return { ok = false, error = "readback", detail = rec.start .. "+" .. rec.duration }
  end
  return { ok = true, id = rec.id, records = { rec } }
end

handlers["item.set"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local item = itemOf(cmd.id)
  if not item then return { ok = false, error = "unknown-item" } end
  local base = tl:GetStartFrame()
  local known = tlItems[cmd.id]
  local kind, index = known.kind, tonumber(cmd.trackIndex) or known.index
  -- Trims: source start first (moves the head), then the length.
  if cmd.srcStart ~= nil and item:GetLeftOffset() ~= nil and item:GetLeftOffset() ~= tonumber(cmd.srcStart) then
    item:SetLeftOffset(tonumber(cmd.srcStart))
  end
  if cmd.duration ~= nil and item:GetDuration() ~= tonumber(cmd.duration) then
    local right = item:GetRightOffset()
    if right == nil then return { ok = false, error = "cannot-trim" } end
    -- Offsets are in timeline frames, at whatever speed the clip plays.
    item:SetRightOffset(right + item:GetDuration() - tonumber(cmd.duration))
  end
  if cmd.start ~= nil or cmd.trackIndex ~= nil then
    local target = { startFrame = base + (tonumber(cmd.start) or (item:GetStart() - base)), trackIndex = index }
    if item:GetStart() ~= target.startFrame or index ~= known.index then item:SetPosition(target) end
  end
  setCommon(item, cmd)
  local rec = keepItem(tl, item, kind, index)
  if not rec then return { ok = false, error = "unreadable" } end
  if (cmd.start ~= nil and rec.start ~= tonumber(cmd.start)) or (cmd.duration ~= nil and rec.duration ~= tonumber(cmd.duration)) then
    return { ok = false, error = "readback", records = { rec } }
  end
  return { ok = true, records = { rec } }
end

handlers["item.delete"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local item = itemOf(cmd.id)
  if not item then return { ok = true } end
  if not tl:DeleteClips({ item }, false) then return { ok = false, error = "delete-failed" } end
  tlItems[cmd.id] = nil
  return { ok = true, gone = { cmd.id } }
end

handlers["item.link"] = function(cmd)
  local tl, err = currentFor(cmd)
  if not tl then return { ok = false, error = err } end
  local items, records = {}, {}
  for _, id in ipairs(type(cmd.ids) == "table" and cmd.ids or {}) do
    local it = itemOf(id)
    if it then items[#items + 1] = it end
  end
  if #items < 1 then return { ok = false, error = "unknown-item" } end
  if not tl:SetClipsLinked(items, cmd.linked ~= false) then return { ok = false, error = "link-failed" } end
  for _, it in ipairs(items) do
    local k = tlItems[it:GetUniqueId()]
    local rec = keepItem(tl, it, k.kind, k.index)
    if not rec then return { ok = false, error = "unreadable" } end
    records[#records + 1] = rec
  end
  return { ok = true, records = records }
end

-- Markers (SPEC §21.4) ----------------------------------------------------------------
-- There's no call that changes a marker: a change deletes it and adds it
-- again. Every write is read back.

local MARKER_COLORS = {}
for _, c in ipairs({ "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender", "Sky", "Mint",
  "Lemon", "Sand", "Cocoa", "Cream" }) do MARKER_COLORS[c] = true end

local function markerAt(owner, frame)
  for _, m in ipairs(M.markerList(owner:GetMarkers())) do
    if m.frame == frame then return m end
  end
end

-- A marker the per-frame calls can't reach. Resolve copies a pool clip's
-- markers onto every item made from it; on an item whose frame rate differs
-- from the timeline's, a copy can land between frames. GetMarkers lists it
-- at the frame below, where the per-frame calls (and DeleteMarkerByCustomData)
-- don't find it (M5 copy probe, 2026-11-04).
local function stuck(owner, frame)
  return owner:GetMarkerCustomData(frame) == nil
end

-- Puts every marker of the owner on the frame GetMarkers lists, so each can
-- be reached: "delete all" does clear in-between markers, and they're added
-- back with every value and tag, then read back (SPEC §21.4). An owner that
-- couldn't be snapped isn't tried again in this run.
local snapFailed = {}
local function snapMarkers(owner)
  local uid = owner:GetUniqueId()
  if snapFailed[uid] then return "unreachable" end
  local list = M.markerList(owner:GetMarkers())
  owner:DeleteMarkersByColor("All")
  for _, m in ipairs(list) do owner:AddMarker(m.frame, m.color, m.name, m.note, m.duration, m.tag) end
  for _, m in ipairs(list) do
    local n = markerAt(owner, m.frame)
    if not (n and n.color == m.color and n.name == m.name and n.note == m.note and n.duration == m.duration and n.tag == m.tag)
      or stuck(owner, m.frame) then
      snapFailed[uid] = true
      return "snap-failed"
    end
  end
end

-- The marker at frame, snapped first if it's out of reach. Returns it, or
-- nil and why.
local function reachableAt(owner, frame)
  local m = markerAt(owner, frame)
  if not m then return nil, "unknown-marker" end
  if not stuck(owner, frame) then return m end
  local err = snapMarkers(owner)
  if err then return nil, err end
  return markerAt(owner, frame)
end

-- The marker's owner: the current timeline, an item on it, or a pool clip.
-- Returns the owner, or nil and why; then the timeline (for timeline
-- markers) and how to read the owner's record back (items and clips).
local function markerOwner(cmd)
  local o = type(cmd.owner) == "table" and cmd.owner or {}
  if o.kind == "clip" then
    local clip, binId = clipOf(o.id)
    if not clip then return nil, "unknown-clip" end
    return clip, nil, nil, function() return keepClip(clip, binId) end
  end
  local tl, err = currentFor(cmd)
  if not tl then return nil, err end
  if o.kind == "timeline" then
    if o.id ~= tl:GetUniqueId() then return nil, "not-current" end
    return tl, nil, tl, nil
  end
  local item = itemOf(o.id)
  if not item then return nil, "unknown-item" end
  local k = tlItems[o.id]
  return item, nil, nil, function() return keepItem(tl, item, k.kind, k.index) end
end

local function badMarker(cmd)
  local frame, duration = tonumber(cmd.frame), tonumber(cmd.duration)
  if not frame or frame < 0 or frame ~= math.floor(frame) then return "bad-frame" end
  if not duration or duration < 1 or duration ~= math.floor(duration) then return "bad-duration" end
  if not MARKER_COLORS[cmd.color] then return "bad-color" end
  if type(cmd.name) ~= "string" or type(cmd.note) ~= "string" or type(cmd.tag) ~= "string" then return "bad-marker" end
end

-- Adds the marker; one that reads back wrong is removed again.
local function addMarker(owner, cmd)
  local frame, duration = tonumber(cmd.frame), tonumber(cmd.duration)
  if markerAt(owner, frame) then return "occupied" end
  if not owner:AddMarker(frame, cmd.color, cmd.name, cmd.note, duration, cmd.tag) then return "add-failed" end
  local m = markerAt(owner, frame)
  if not (m and m.color == cmd.color and m.name == cmd.name and m.note == cmd.note and m.duration == duration and m.tag == cmd.tag) then
    if m then owner:DeleteMarkerAtFrame(frame) end
    return "readback"
  end
end

-- The answer: the owner's fresh record, or for timeline markers the records
-- of `frames` and which of `cleared` now hold none. Either way they're kept
-- as reported, so the next scan doesn't report the bridge's own change.
local function markerDone(owner, tl, keep, err, frames, cleared)
  local r = { ok = err == nil, error = err }
  if keep then
    local rec = keep()
    r.records = rec and { rec } or nil
    return r
  end
  local now, id = {}, tl:GetUniqueId()
  for _, m in ipairs(M.markerList(owner:GetMarkers())) do now[m.frame] = m end
  r.records, r.markerGone = {}, {}
  local done = {}
  for _, f in ipairs(frames) do
    if now[f] and not done[f] then
      done[f] = true
      local rec = markerRecord(id, now[f])
      tlMarkers[f] = M.jencode(rec)
      r.records[#r.records + 1] = rec
    end
  end
  for _, f in ipairs(cleared) do
    if not now[f] then
      tlMarkers[f] = nil
      r.markerGone[#r.markerGone + 1] = f
    end
  end
  tlMarkersOwn = bmd.gettime()
  return r
end

handlers["marker.add"] = function(cmd)
  local owner, err, tl, keep = markerOwner(cmd)
  if not owner then return { ok = false, error = err } end
  local bad = badMarker(cmd)
  if bad then return { ok = false, error = bad } end
  return markerDone(owner, tl, keep, addMarker(owner, cmd), { tonumber(cmd.frame) }, {})
end

handlers["marker.set"] = function(cmd)
  local owner, err, tl, keep = markerOwner(cmd)
  if not owner then return { ok = false, error = err } end
  local bad = badMarker(cmd)
  if bad then return { ok = false, error = bad } end
  local at = tonumber(cmd.at)
  if not at then return { ok = false, error = "bad-frame" } end
  local old, why = reachableAt(owner, at)
  if not old then return markerDone(owner, tl, keep, why, { at }, {}) end
  owner:DeleteMarkerAtFrame(at)
  -- Never add while the old one is still there: that would make two.
  if markerAt(owner, at) then return markerDone(owner, tl, keep, "unreachable", { at }, {}) end
  local failed = addMarker(owner, cmd)
  -- Couldn't place the new values: put the old marker back.
  if failed then owner:AddMarker(old.frame, old.color, old.name, old.note, old.duration, old.tag) end
  return markerDone(owner, tl, keep, failed, { tonumber(cmd.frame), at }, { at })
end

handlers["marker.delete"] = function(cmd)
  local owner, err, tl, keep = markerOwner(cmd)
  if not owner then return { ok = false, error = err } end
  local frame = tonumber(cmd.frame)
  if not frame then return { ok = false, error = "bad-frame" } end
  if markerAt(owner, frame) then
    local m, why = reachableAt(owner, frame)
    if not m then return markerDone(owner, tl, keep, why, { frame }, {}) end
    owner:DeleteMarkerAtFrame(frame)
  end
  return markerDone(owner, tl, keep, markerAt(owner, frame) and "delete-failed" or nil, {}, { frame })
end

handlers["marker.tag"] = function(cmd)
  local owner, err, tl, keep = markerOwner(cmd)
  if not owner then return { ok = false, error = err } end
  local frame = tonumber(cmd.frame)
  if not frame or type(cmd.tag) ~= "string" then return { ok = false, error = "bad-marker" } end
  local found, why = reachableAt(owner, frame)
  if not found then return markerDone(owner, tl, keep, why, { frame }, {}) end
  owner:UpdateMarkerCustomData(frame, cmd.tag)
  local m = markerAt(owner, frame)
  return markerDone(owner, tl, keep, not (m and m.tag == cmd.tag) and "readback" or nil, { frame }, {})
end

-- A media pool snapshot (asked for by a companion that attached late) also
-- reports the timelines again.
local poolSnapshot = handlers["mp.snapshot"]
handlers["mp.snapshot"] = function(cmd)
  local r = poolSnapshot(cmd)
  tlListSig, tlCurrent = nil, nil
  return r
end

-- Backups go next to the inbox only: %USERPROFILE%\ResolveCollab\backups\.
local BACKUPS = INBOX:gsub("[\\/][^\\/]+$", "") .. "\\backups\\"

-- A new empty project for a first join (SPEC §22.3), opened. The project
-- that was open is saved first and left as it was. A taken name gets a number.
handlers["project.create"] = function(cmd)
  if not validName(cmd.name) or #cmd.name > 200 then return { ok = false, error = "bad-name" } end
  pm:SaveProject()
  local p, name
  for n = 1, 50 do
    name = n == 1 and cmd.name or (cmd.name .. " (" .. n .. ")")
    p = pm:CreateProject(name)
    if p then break end
  end
  if not p then return { ok = false, error = "create-failed" } end
  local open = pm:GetCurrentProject()
  if not open or open:GetUniqueId() ~= p:GetUniqueId() then return { ok = false, error = "not-opened" } end
  return { ok = true, id = p:GetUniqueId(), name = p:GetName() }
end

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

-- Marks the items a timeline command touches, and the items linked to
-- them, as changed by us (see tlOwn).
local function markOwn(ids)
  local now = bmd.gettime()
  for _, uid in ipairs(ids) do
    if type(uid) == "string" then
      tlOwn[uid] = now
      local k = tlItems[uid]
      local ok, linked = pcall(function() return k and k.obj:GetLinkedItems() end)
      for _, l in ipairs(ok and linked or {}) do tlOwn[l:GetUniqueId()] = now end
    end
  end
end

local function touched(message, result)
  local ids = { message.id }
  if type(message.owner) == "table" then ids[#ids + 1] = message.owner.id end
  for _, id in ipairs(type(message.ids) == "table" and message.ids or {}) do ids[#ids + 1] = id end
  if type(message.edge) == "table" then ids[#ids + 1] = message.edge.item end
  for _, rec in ipairs(type(result) == "table" and type(result.records) == "table" and result.records or {}) do
    ids[#ids + 1] = rec.id
    for _, l in ipairs(rec.linked or {}) do ids[#ids + 1] = l end
  end
  return ids
end

local function handle(message)
  local handler = type(message) == "table" and handlers[message.type]
  if not handler then return { ok = false, error = "unknown-command" } end
  local kind = type(message.type) == "string" and message.type or ""
  -- Items, and markers on items, changed by us.
  local edits = kind:match("^item%.") ~= nil or (kind:match("^marker%.") ~= nil and type(message.owner) == "table" and message.owner.kind == "item")
  if edits then markOwn(touched(message)) end -- before: a delete takes the links with it
  local ok, result = pcall(handler, message)
  if not ok then return { ok = false, error = "exception", detail = tostring(result) } end
  if edits then markOwn(touched(message, result)) end
  return result
end

-- Main loop -------------------------------------------------------------------------

F:SetPrefs(ACTIVE_PREF, bridgeId) -- a newer bridge run takes over from this one
-- handled: this run counts inbox messages from 0 (a companion that wrote
-- for an earlier run starts again from here).
emit("HELLO", { product = R:GetProductName(), version = R:GetVersionString(), studio = R:IsStudio(), inbox = INBOX, handled = 0, build = BUILD })
snapshotMediaPool()

local lastHandled, lastBeat, lastScan, lastPoolScan = 0, 0, 0, 0
while F:GetPrefs(ACTIVE_PREF) == bridgeId do
  bmd.wait(TICK)
  local now = bmd.gettime()
  local stopping = false
  -- bmd.direxists has no side effects; without it, list every tick.
  local ready = not bmd.direxists or bmd.direxists(INBOX .. "\\" .. M.readyName(lastHandled + 1))
  local messages = ready and M.decodeInbox(ms:GetSubFolderList(INBOX) or {}, lastHandled) or {}
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
    local ok, err = pcall(scanTimelines)
    if not ok then emit("ERR", { error = "scan-failed", detail = tostring(err) }) end
  end
  if now - lastPoolScan >= MEDIA_POOL_EVERY then
    lastPoolScan = now
    local project = pm:GetCurrentProject()
    local ok, err = pcall(function()
      -- Another project open: report it whole, and the companion pauses (SPEC §9.2).
      if project and project:GetUniqueId() ~= mpProject then
        snapshotMediaPool()
        tlListSig, tlCurrent = nil, nil -- and the timelines, whole
      else
        scanMediaPool(true)
      end
    end)
    if not ok then emit("ERR", { error = "media-pool-scan-failed", detail = tostring(err) }) end
  end
  if now - lastBeat >= HEARTBEAT_EVERY then
    lastBeat = now
    emit("HB", { t = now, handled = lastHandled, build = BUILD })
  end
end
emit("ERR", { error = "bridge-stopped" })
