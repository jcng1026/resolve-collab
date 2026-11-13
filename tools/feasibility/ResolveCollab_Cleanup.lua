-- ResolveCollab cleanup: deletes the scratch projects the checks and probes
-- made (M1 to M9), by name pattern, never the open project. Asked for by the
-- user on 2026-11-13. Run from Workspace > Scripts > ResolveCollab_Cleanup
-- while `node tools/feasibility/collect.ts --name cleanup` is running.

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


local PATTERNS = {
  "^ResolveCollab Feasibility", "^ResolveCollab M%d+ ", "^ResolveCollab FPS Probe",
  "^RC M%d+ Check", "^RC M%d+ Host %(collab",
}

local function scratch(name)
  for _, p in ipairs(PATTERNS) do if name:find(p) then return true end end
  return false
end

put("Stage", "started")
local R = resolve
local pm = R:GetProjectManager()
local open = pm:GetCurrentProject()
local openName = open and open:GetName()
results.open = openName
local deleted, failed, kept = {}, {}, {}
for _, name in ipairs(pm:GetProjectListInCurrentFolder() or {}) do
  if scratch(name) and name ~= openName then
    local ok, r = pcall(function() return pm:DeleteProject(name) end)
    if ok and r then deleted[#deleted + 1] = name else failed[#failed + 1] = name end
  else
    kept[#kept + 1] = name
  end
end
results.deleted, results.failed, results.kept = deleted, failed, kept
results.stillOpen = (pm:GetCurrentProject() and pm:GetCurrentProject():GetName()) or ""
finish("Completed.")
