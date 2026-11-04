# M5 two-PC test

Checks SPEC §21: markers on the timeline ruler, on clips in a timeline, and on media pool clips sync both ways, live and after time offline.

## On both PCs (once)
1. Get the latest code, then reinstall the bridge:
   ```
   git pull
   npm install
   node tools/install-bridge.ts
   ```
   (On PC 2 use `npm.cmd` if PowerShell blocks `npm`.)
2. Use the same video files A and B as before (identical copies on both PCs).
3. In Resolve on each PC, make a **new empty project** (File → New Project).
4. Start the bridge: **Workspace → Scripts → ResolveCollab**. If it was already running, start it again.

## Run
1. PC 1: `node src/companion.ts host`, then copy the invite code.
2. PC 2: `node src/companion.ts join <invite-code>`.

Wait 2–3 seconds after each change before checking the other PC.

### Markers from PC 1
3. PC 1:
   - import A and B, make a timeline `Edit`, and drag A onto it, then B after it (both clips side by side);
   - **ruler markers:** click the ruler at two places with no clip edge, pressing **M** each time;
   - double-click one of them, give it a name and a note with a new line in it, and pick a colour;
   - **clip marker:** move the playhead over clip A first (clicking the ruler deselects clips), then click clip A itself to select it, and press **M**. The marker shows on the clip, and on its linked audio too;
   - **media pool marker:** double-click B in the media pool (it opens in the source viewer on the left), and press **M** there.

   On PC 2: the same two ruler markers (name, note, colour), the marker on A, and B's marker in its source viewer.

### Markers from PC 2
4. PC 2, on `Edit`:
   - drag the named ruler marker to another place on the ruler;
   - double-click it and change its colour;
   - delete the other ruler marker (double-click it → **Remove Marker**);
   - double-click the marker on A and change its note.

   On PC 1: the marker moved and recoloured (still one marker, not a new one), the other gone, A's marker with the new note.

### A clip added again
5. PC 1: drag B from the media pool onto the timeline again, after the others. Resolve copies B's media pool marker onto the new clip.

   On PC 2: the new clip has **one** marker, not two. If B's frame rate differs from the timeline's, Resolve puts the copy between frames; the bridge moves it onto a whole frame so it can be synced (SPEC §21.4). Then on PC 2, change that marker's note: PC 1 shows the new note, still with one marker.

### A timeline that isn't open
6. PC 2: make a new timeline `Second`, drag A onto it, and press **M** on the ruler.
7. PC 1 (still on `Edit`): `Second` appears with no marker yet; its companion says the changes will be applied when you open it. Open `Second`: the marker appears. Go back to `Edit`.

### A duplicated timeline
8. PC 1: in the media pool, right-click `Edit` → **Duplicate Timeline**. Open the copy and change the colour of one of its ruler markers.

   On PC 2: the copy has the same markers, with that one recoloured, and the original `Edit` is unchanged.

### Offline merge
9. PC 2: close the companion (Ctrl+C), leaving Resolve and the bridge running.
10. While it's closed, on `Edit`:
    - PC 2 changes the colour of the named ruler marker;
    - PC 1 changes its name;
    - **both** add a ruler marker at the **same** frame (put the playhead at the same timecode on both, for example by typing it into the timecode box above the timeline, check it moved, and press **M**), then double-click it and give it a **different colour on each PC**. Two markers alike in every value count as one marker, so they must differ.
11. PC 2: start the companion again with the same `join` command. PC 2 saves a backup and asks **one** question, about the two markers on that frame (only one fits). Answer `m`.
    - The named marker has PC 2's colour and PC 1's name, on both PCs (that wasn't a question: they changed different things).
    - On that frame, both PCs have **PC 2's** marker. (With `t`, both would have PC 1's.)

Send me both companions' output if anything fails.

## Known M5 limits
- Markers on a timeline you don't have open arrive when you open it, like clips.
- Two markers on the same frame can't both exist in Resolve. After time offline, the returning person picks which stays; live, the first to reach the host stays and the other PC is told. The person whose marker was replaced gets a notice with Restore mine in M7.
- A timeline duplicated before a session starts: whichever of the two is opened first in the session keeps the markers' hidden IDs, and the other's markers get new ones. Both keep the right markers.
- A marker whose hidden data was written by another tool or script keeps that data; if you move it, it syncs as removed here and added there.
