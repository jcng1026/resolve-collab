-- ResolveCollab bridge (SPEC §3, §18). Runs inside DaVinci Resolve from
-- Workspace > Scripts > ResolveCollab and talks to the companion app:
--   out: errors raised through fusion:Execute, which Resolve writes to
--        Support/logs/ResolveDebug.txt as  RC|<bridgeId>|<kind>|<hex(JSON)>
--   in:  subfolders of the inbox named  <seq:8>.<part:3>.<parts:3>.<hex(JSON)>,
--        listed with MediaStorage:GetSubFolderList (Free has no file reads).
-- Inbound text is only ever parsed as JSON by jdecode below, never executed.

-- Tests load this file with loadfile(path)("test") to get the pure helpers.
local MODE = ...

local INBOX = [[__INBOX__]]
local TICK = 0.05
local SNAPSHOT_EVERY = 0.3
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
    for k, x in pairs(v) do parts[#parts + 1] = jstr(tostring(k)) .. ":" .. M.jencode(x) end
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

local function emit(kind, payload)
  local h = M.hex(M.jencode(payload))
  if #h > MAX_OUT_HEX then
    h = M.hex(M.jencode({ error = "payload-too-large", kind = kind, bytes = #h / 2 }))
    kind = "ERR"
  end
  F:Execute('error("RC|' .. bridgeId .. '|' .. kind .. '|' .. h .. '")')
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

local handlers = {}

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

local lastHandled, lastBeat, lastScan = 0, 0, 0
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
  if now - lastBeat >= HEARTBEAT_EVERY then
    lastBeat = now
    emit("HB", { t = now })
  end
end
emit("ERR", { error = "bridge-stopped" })
