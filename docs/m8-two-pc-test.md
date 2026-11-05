# M8 two-PC test, part 1: the window, presence, chat, Follow

Checks SPEC §24 (and §8, §11): the chat bar and strip, people and where they are, Follow, chat, the change list and jumping to a change. Ghost cursors come in part 2.

## On both PCs (once)
1. Close any companion. `git pull`, `npm install` (PC 2: `npm.cmd install`; it downloads Electron, about 100 MB), `node tools/install-bridge.ts`.
2. In Resolve: **Workspace → Scripts → ResolveCollab**.

## Run
### Starting from the window
1. PC 1: open a test project with a clip on a timeline. Run `node src/companion.ts` (no arguments). A window opens at the bottom right, on top of everything: **Start a new session from …**. Click it.
2. PC 1: **⋯ → Session and invite code**, **Copy**, and send the code to PC 2.
3. PC 2: run `node src/companion.ts`, paste the code under **Join**, click **Join**.
   - PC 1: an orange card above the bar: **PC2 wants to join**. Click **Let in**.
   - PC 2: the window shows the session; a new project "… (collab · hosted by PC 1)" opens in Resolve.

### The bar and the strip
4. Both: the bar shows the project, **Live · 2 people**, and "No messages yet". Type a message in **Reply** and press Enter: it shows on the other PC's bar.
5. Drag the bar by its top line to the top of the screen; click the chevron: the strip opens **downward** and the chevron points down. Drag it back to the bottom: it opens upward again. Close and restart the companion: it comes back where you left it.
6. Expand. In the header, hover the other person's initial: it shows their page, timeline and timecode. Move the playhead on the other PC: it updates (within about a second).

### Follow
7. PC 2: click PC 1's initial. "Following PC 1 · Stop" shows. On PC 1, move the playhead, switch timeline, go to the Color page: PC 2's Resolve follows each. Back on the Edit page.
8. PC 2: change something (a clip colour). Following stops by itself. Follow again and press **Stop**: it stops.

### Changes and jumping
9. PC 1: move a clip on the timeline, recolour a clip, add a marker. PC 2, strip, **Chat**: grey lines like "PC 1 · 10:42 · moved Interview_03 on V1". **Changes**: each with old → new values; the filter by person works.
10. PC 2: click a change line: Resolve goes to that timeline at that spot. In chat, send "look at 01:00:05:00"; click the timecode on the other PC: its playhead goes there.

### Urgent cards and closing
11. Make a lost race (as in the M7 test, both recolour at once): the loser gets an orange card above the bar, pulsing; **Send mine again** works.
12. PC 1 (host): **×** asks Minimize or close, with the warning that closing ends the session for everyone. **Minimize** goes back to the bar. Tick **Remember my choice** and pick Minimize: next time × just minimizes (**⋯ → Settings** sets it back to Ask).
13. PC 2: stop Resolve's bridge (or close Resolve's project): an orange card says sync is paused. Start it again: the card goes by itself.

Send me both companions' terminal output if anything fails.

## Known limits (part 1)
- Windows' acrylic glass covers the whole window, so the urgent cards sit inside the same glass panel as the bar rather than floating on their own.
- Change lines show timecode from a 01:00:00:00 start (Resolve's default).
- To change your name, start with `--name`.
