# M6 two-PC test

Checks SPEC §22: joining with approval, a fresh project on the first join, a new invite code every time the session is opened, the host closing or dropping out, removing a member, and ending for good.

## On both PCs (once)
1. Get the latest code, then reinstall the bridge:
   ```
   git pull
   npm install
   node tools/install-bridge.ts
   ```
   (On PC 2 use `npm.cmd` if PowerShell blocks `npm`.)
2. In Resolve, start the bridge again: **Workspace → Scripts → ResolveCollab**. If a companion says the bridge isn't the one it was installed with, do this step again.
3. The first time you start a companion, it asks for your name. That's what the other PC sees.

## Run

### A new session and a first join
1. PC 1: open the project to share (for example your test project) and run `node src/companion.ts host`. Copy the invite code.
2. PC 2: have **any** project open; note which one. Run `node src/companion.ts join <invite-code>`.
   - PC 2's companion says it's waiting for PC 1 to let you in.
   - PC 1's companion asks: `<name> (<ID>) wants to join. y = let in, n = not now, b = block this PC`. Answer `y`.
3. On PC 2:
   - Resolve opens a **new** project named `<PC 1's project> (collab · hosted by <PC 1's name>)`;
   - it fills with PC 1's media pool, timelines and markers;
   - the project that was open before is unchanged (check it later in the Project Manager).
4. Make an edit on each PC (a clip colour, a marker): it shows on the other.

### The host closing, and resuming another day
5. PC 1: close the companion (Ctrl+C). PC 2's companion says PC 1 closed the session, and stops.
6. PC 2: make a change in its project while the session is closed (for example a clip colour).
7. PC 1: with the same project open, run `node src/companion.ts host --resume`. It says it's resuming, and shows a **new** invite code.
8. PC 2: try the **old** code first: either nothing is found (stop it with Ctrl+C after about 20 seconds), or it says the code is from an earlier opening and stops; PC 1 says PC 2 used an old code. Either way PC 2 is **not** let in. Then run `join <new code>`.
   - PC 1 is **not** asked again;
   - PC 2's companion says it rejoined, in the same collab project (if another project is open, it says which one to open);
   - PC 2's change from step 6 reaches PC 1.

### The host dropping out
9. PC 1: disconnect from the internet (or pull the cable) for about a minute, then reconnect. PC 2 says the host is unreachable, then reconnects by itself and syncs again.

### Removing and ending
10. PC 1: type `members`: PC 2 is listed as online. Type `remove <PC 2's name>`. PC 2's companion says it was removed, and stops. Running `join` with the code again on PC 2 is refused.
11. PC 1: type `unblock <PC 2's name>`, and let PC 2 join again (`y`).
12. PC 1: type `end` and answer `y`. PC 2 says the session was ended for good. PC 1's `host --resume` then says the project isn't a session it hosts.

Send me both companions' output if anything fails.

## Known M6 limits
- The joiner's project is built by syncing, so only what v1 syncs arrives (media pool, timelines, markers); grades, Fusion and effects don't (SPEC §6.1).
- A host whose companion crashed and was started again (`--resume`) has a new code, so members need it to rejoin.
- A first join trusts whoever answers on the invite code as the host; from then on, only that PC is accepted as the host.
- A PC that lost its ResolveCollab folder (identity and records) is a new PC: the host is asked again, and it gets a fresh project.
