# ResolveCollab

Real-time collaboration for DaVinci Resolve: a Lua bridge inside Resolve plus a TypeScript companion app that syncs peers. `docs/SPEC.md` is the source of truth for behaviour and decisions; update it when a decision changes.

# Commands
- Typecheck + tests: `npm run check`
- Tests only: `npm test` · one file: `npx vitest run src/path/file.test.ts`
- Node lives in `C:\Program Files\nodejs`; a shell opened before it was installed may need that on PATH.

# Rules
- Never invent Resolve API methods. Only use calls listed in the scripting README shipped with Resolve (copy it into `docs/resolve-api/` once Resolve is installed) or confirmed by the feasibility results (`docs/feasibility/`). If a call isn't there, say so instead of guessing.
- Every write through the Resolve API must be read back to confirm it persisted (SPEC §15 F12).
- Peers send data, never code. Bridge request files are produced only by `src/bridge-protocol/` and must stay pure Lua table literals (SPEC §3.2, §13).
- Target genuine Resolve Free/Studio 21.1+ on Windows only. Do not add workarounds for cracked or modified builds.
- Free 21.1.2 Lua sandbox: no `io`, `loadfile`, `dofile`, `require`, `os.execute`, `bmd.readfile`/`writefile`, `fusion:SavePrefs`, sockets or UIManager. Python is Studio-only. Use the `resolve` global, not `Resolve()` (blocks ~4 s, then fails).

# Gotchas
- Genuine Resolve Free 21.1.2 is installed on the dev PC. Workspace ▸ Console runs Lua and is the quickest way to check a call. Feasibility tooling: `tools/feasibility/` (state in gitignored `local/`).
- Files written under `%LOCALAPPDATA%` from the Claude desktop app are invisible to Resolve (packaged-app redirection).
