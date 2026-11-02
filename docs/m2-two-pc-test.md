# M2 two-PC test

Checks SPEC §18: a clip added on one PC appears on the other within 2 seconds.

## On both PCs (once)
1. Install genuine DaVinci Resolve Free or Studio 21.1+ and Node.js 22+.
2. Clone the repo, then run:
   ```
   npm install
   node tools/install-bridge.ts
   ```
3. Restart Resolve so **Workspace → Scripts → ResolveCollab** appears.
4. Open the same project setup on both PCs:
   - a timeline with the **same name** (for example `Timeline 1`) as the current timeline;
   - the **same media file** (same file name) imported into the media pool. Media transfer comes in M9.

## Run
1. PC 1: `node src/companion.ts host`, then copy the invite code it prints.
2. PC 2: `node src/companion.ts join <invite-code>`.
3. On both PCs: **Workspace → Scripts → ResolveCollab**. Each companion prints `bridge connected`.
4. Wait for `peer … connected` on both.
5. On PC 1, drag the clip from the media pool onto the timeline. Within ~2 s it should appear at the same position on PC 2, and PC 2's companion prints `applied`. Repeat from PC 2 to PC 1.

## Known M2 limits
- Only "clip added to the current timeline" syncs. Moves, trims, deletes etc. come later.
- The receiver must be on a timeline with the same name, and must have the media.
- Anyone with the invite code can join (host approval is M6).
- The bridge writes a heartbeat line to Resolve's debug log every second. If the Console is open, these lines show there too.
- To stop the bridge, close Resolve, or run the script again (a new run takes over from the old one).
