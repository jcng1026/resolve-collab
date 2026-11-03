# M4 two-PC test

Checks SPEC §16/§20: timelines sync both ways, live and after time offline, including timelines that aren't open, titles, transitions and fades.

## On both PCs (once)
1. Get the latest code, then reinstall the bridge:
   ```
   git pull
   npm install
   node tools/install-bridge.ts
   ```
   (On PC 2 use `npm.cmd` if PowerShell blocks `npm`.)
2. Use the same video files A and B as for M3 (identical copies in Downloads or Videos on both PCs). If one of them has a different frame rate from the timeline (for example a 30 fps phone clip on a 24 fps timeline), even better.
3. In Resolve on each PC, make a **new empty project** (File → New Project). Don't use a project you care about.
4. Start the bridge: **Workspace → Scripts → ResolveCollab**. If it was already running, start it again; the new run takes over.

## Run
1. PC 1: `node src/companion.ts host`, then copy the invite code. Keep the "to resume" line.
2. PC 2: `node src/companion.ts join <invite-code>`.

### Build a timeline on PC 1
3. PC 1:
   - import A and B into the media pool;
   - make a timeline called `Edit` (File → New Timeline);
   - drag A onto it, then B after it.
   - while dragging B, hold it over the timeline for about 5 seconds before letting go (this crashed Resolve before the fix). Nothing should reach PC 2 until you let go.

   Within a few seconds PC 2 has a timeline `Edit` with A and B at the same places, video and audio linked. If PC 2 already had another timeline open, its companion says the changes will be applied when you open `Edit`: open it.

### Live edits, PC 2 → PC 1
4. PC 2, on `Edit`:
   - trim the end of A shorter;
   - drag B a second later;
   - give A a clip colour;
   - in the Inspector, zoom B to 1.5.

   Each shows on PC 1 within a few seconds.

### Titles and transitions, PC 1 → PC 2
5. PC 1:
   - add a video track;
   - drag a **Text+** title onto it (Effects → Titles → Fusion Titles) and change its words in the Inspector;
   - drag a basic **Text** title next to it;
   - put a **Cross Dissolve** between A and B.

   On PC 2:
   - the Text+ shows **your words**;
   - the basic Text title is in the right place and length, with placeholder words;
   - PC 2's companion says basic title words don't sync;
   - the dissolve is there.

### Deletes and enable
6. PC 2: select B and press Delete, then disable A (right-click → Enable/Disable Clip). Both show on PC 1.

### Fades
7. PC 1: drag the fade-in handle at the top-left corner of A. The fade shows on PC 2.
8. PC 2: open another project, then open this one again. Resolve forgets fades set by scripts, so the companion puts it back within a few seconds. Check A still fades in on PC 2.

### A timeline that isn't open
9. PC 2: make a new timeline `Second` and drag B onto it.
10. PC 1 (still on `Edit`):
    - `Second` appears in the media pool;
    - PC 1's companion says `changes to "Second" will be applied when you open it`;
    - open `Second`: B appears.

### Offline merge
11. PC 2: close the companion (Ctrl+C), leaving Resolve and the bridge running.
12. While it's closed, on `Edit`:
    - PC 2 moves A a little later;
    - PC 1 changes A's clip colour;
    - **both** trim the end of A, to different lengths.
13. PC 2: start the companion again with the same `join` command. It saves a backup, then asks **only about the length** (both changed it). Answer `m`. On both PCs, A has PC 2's position and length and PC 1's colour.

### Deleting a timeline
14. PC 1: in the media pool, delete the timeline `Second`. PC 1's companion asks "Delete it for everyone?": answer `y`. PC 2 saves a backup, then `Second` disappears there.

Send me both companions' output if anything fails.

## Known M4 limits
- Basic Text titles' words and generator settings (e.g. Solid Color's colour) don't sync; use Text+ for titles. Compound clips, multicam, Fusion clips, effects, keyframes and Fairlight settings don't sync yet.
- Changes to a timeline you don't have open are applied when you open it. Until then, rendering that timeline renders the older version.
- Fades are put back only while the bridge runs. A PC that opens or renders the project without ResolveCollab running won't have fades made on other PCs.
- When two people change the same thing at the same moment, the later change wins and the overwritten person sees a notice (first-to-host-wins with undo is M7).
- A track inserted between two others can't be synced (Resolve can't do it by script, and replacing the whole timeline with another PC's file was switched off for safety). The other PC's companion says so; add the track there by hand, or add new tracks at the top.
- Timeline changes from other PCs wait while you hold the left mouse button (anywhere, in any app) and for 1 s after your last timeline edit, so they never land in the middle of a drag.
- Anyone with the invite code can join (host approval is M6).
