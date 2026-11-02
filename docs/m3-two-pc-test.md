# M3 two-PC test

Checks SPEC §16/§19: bins and clips sync both ways, live and after time offline, and media the other PC lacks is listed and can be located.

## On both PCs (once)
1. Genuine DaVinci Resolve Free or Studio 21.1+ and Node.js 22+ (as for M2).
2. In the repo, get the latest code, then run:
   ```
   git pull
   npm install
   node tools/install-bridge.ts
   ```
   (On PC 2 use `npm.cmd` if PowerShell blocks `npm`.)
3. Put two short video files in **Downloads** or **Videos** on **both** PCs, with the same names and identical content (copy them over, e.g. by USB stick). Call them A and B below. Also put a third file C on PC 1 only.
4. In Resolve on each PC, make a **new empty project** (File → New Project). Don't use a project you care about: the test changes its media pool.

## Run
1. PC 1: `node src/companion.ts host`, then copy the invite code it prints. Note the "to resume" line.
2. PC 2: `node src/companion.ts join <invite-code>`.
3. On both PCs: **Workspace → Scripts → ResolveCollab**. Each companion prints `bridge connected`; PC 2 prints `joined the session`.

### Live, PC 1 → PC 2
4. PC 1: make a bin `Day 1` and import A into it. Within ~2 s, PC 2 has `Day 1` with A in it (found in Downloads/Videos by content, not path).
5. PC 1: give A a clip colour, a flag, and a Scene number (Metadata panel). Each shows on PC 2 within a few seconds.
6. PC 1: rename the bin to `Day 1 – Selects`. On PC 2 the bin is renamed (behind the scenes it's a new bin with the clips moved in, since Free can't rename bins from a script).

### Live, PC 2 → PC 1
7. PC 2: import B at the top level, rename the clip, and drag it into `Day 1 – Selects`. Each change appears on PC 1.
8. PC 2: make a bin `Sub` and drag it into `Day 1 – Selects`. It appears on PC 1.

### Missing media
9. PC 1: import C. PC 2's companion prints `missing media: "C…". If you have it: locate <id> <path>`. Type `missing` on PC 2 to list it again.
10. Copy C to PC 2 somewhere **other than** Downloads/Videos/Desktop/Documents, then on PC 2 type `locate <id> <full path>`. It's imported into the right bin.

### Offline merge
11. PC 2: close the companion (Ctrl+C). Leave Resolve and the bridge running.
12. While PC 2 is offline:
    - PC 2: change A's clip colour to Blue.
    - PC 2: rename A to `A (pc2)`.
    - PC 1: rename A to `A (pc1)` and give it a Take number.
13. PC 2: start the companion again with the same `join` command. It saves a backup `.drp` to `%USERPROFILE%\ResolveCollab\backups\`, then asks **only about the name** (both changed it). Answer `m` (keep mine).
14. Check: on both PCs, A is called `A (pc2)`, is Blue, and has PC 1's Take number. PC 1 was not asked anything.

### Deletes and host restart
15. PC 1: delete B. It disappears on PC 2.
16. PC 1: close the companion and start it again with the "to resume" command (`host --code <invite-code>`). PC 2 prints `peer … left`, then rejoins. Make one more change on either PC to confirm sync still works.

Send me both companions' output if anything fails.

## Known M3 limits
- Only the media pool syncs (bins, clips, clip colour, flags, metadata). Timelines, markers, color etc. come later.
- When two people change the same field at the same moment, the later change wins on both PCs and the overwritten person sees a notice (first-to-host-wins with undo is M7).
- Media isn't transferred between PCs yet (M9): each PC needs its own copy of the files.
- Deletes sync immediately and can't be undone through ResolveCollab yet (M7). The backup `.drp` is your safety net.
- Merge questions are asked in the companion window; the real dialog comes with the companion app.
- When the returning person picks "keep mine", the person whose change was replaced isn't told yet. The "… replaced your … — Show / Restore mine" notice (SPEC §9.3, point 7) comes with M7.
- Anyone with the invite code can join (host approval is M6).
- Switching to another project in Resolve pauses sync until you switch back.
