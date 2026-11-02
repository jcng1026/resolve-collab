# ResolveCollab

Real-time collaboration for DaVinci Resolve: a Lua bridge inside Resolve plus a TypeScript companion app that syncs peers. `docs/SPEC.md` is the source of truth for behaviour and decisions; update it when a decision changes.

# Commands
- Typecheck + tests: `npm run check` (includes Lua bridge tests run under Resolve's `fuscript`, and a Hyperswarm test that needs internet; set `RC_SKIP_NETWORK=1` to skip it)
- Tests only: `npm test` · one file: `npx vitest run src/path/file.test.ts`
- Install the bridge into Resolve: `node tools/install-bridge.ts` (Resolve lists a *new* script only after a restart)
- Run the companion: `node src/companion.ts host` / `join <code>`; add `--fake --fake-media <name>` for a simulated Resolve
- Node lives in `C:\Program Files\nodejs`; a shell opened before it was installed may need that on PATH. Imports use `.ts` extensions so Node runs the sources directly.

# Rules
- Never invent Resolve API methods. Only use calls listed in `docs/resolve-api/` (shipped with Resolve 21.1.2) and confirmed by `docs/feasibility/`. If a call isn't there, say so instead of guessing.
- Every write through the Resolve API must be read back to confirm it persisted (SPEC §15 F12).
- Peers send data, never code. Bridge traffic uses only the wire format in `src/bridge-protocol/wire.ts` and `bridge/ResolveCollab.lua` (SPEC §18.1); the bridge parses inbound JSON with its own decoder and never runs it.
- Target genuine Resolve Free/Studio 21.1+ on Windows only. Do not add workarounds for cracked or modified builds.
- Free 21.1.2 Lua sandbox: no `io`, `loadfile`, `dofile`, `require`, `os.execute`, `bmd.readfile`/`writefile`, `fusion:SavePrefs`, sockets or UIManager. Python is Studio-only. Use the `resolve` global, not `Resolve()` (blocks ~4 s, then fails).

# Gotchas
- Genuine Resolve Free 21.1.2 is installed on the dev PC. Workspace ▸ Console runs Lua and is the quickest way to check a call; while it is open it also shows every bridge message.
- Files written under `%LOCALAPPDATA%` from the Claude desktop app are invisible to Resolve (packaged-app redirection). The bridge inbox lives in `%USERPROFILE%\ResolveCollab\inbox`.
- In standalone `fuscript`, a loaded file doesn't see the caller's globals; the bridge takes its test switch as a chunk argument (`loadfile(path)("test")`).
