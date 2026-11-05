# M8 two-PC test, part 1: the window, presence, chat, Follow

Checks SPEC §24 (and §8, §11): the start card, the chat bar and strip, people and where they are, Follow, chat and slash commands, session events, the change list, Leave. Ghost cursors come in part 2.

## On both PCs (once)
1. Close any companion. `git pull`, `npm install` (PC 2: `npm.cmd install`), `node tools/install-bridge.ts`.
2. In Resolve: **Workspace → Scripts → ResolveCollab**.

## Run
### The start card
1. PC 1: open a test project with a clip on a timeline. Run `node src/companion.ts`. A small card opens at the bottom right, on top of everything: a green **Resolve · <project>** pill, **Your name** (filled with last time's), **Host | Join**.
   - The gear shows Settings (what × does, the sound).
   - Clear the name: the buttons grey out. Put it back, click **Start a session from …** (or **Resume …** if this project was hosted before).
2. PC 1: expand, **⋯ → Session and invite code**, **Copy**, send the code to PC 2.
3. PC 2: `node src/companion.ts`, **Join**, paste the code, **Join**. PC 1: an orange card above the bar, pulsing: **wants to join**. **Let in**.
   - Both: a green "PC2 joined" line in the bar.

### The bar, the strip, people
4. Each PC: type a message in the bar and press Enter: it shows on the other. While the other PC's window is collapsed, a blue count shows on its chevron; it goes when they expand.
5. Drag the bar to the top of the screen and expand: the strip opens downward. Back to the bottom: upward. Restart the companion: it comes back where you left it.
6. Hover the other person's initial: only "PC 1 · Edit page · Click to follow". Leave one PC alone for 5 minutes: a small moon shows on its initial, and "Idle" in the hover. Touch the playhead: the moon goes.

### Follow
7. PC 2: click PC 1's initial. "Following PC 1 · Edit page" with Stop; both histories get "PC2 is following PC 1". PC 1: move the playhead, switch timeline, go to the Color page: PC 2 follows. Back to Edit.
8. PC 2: change a clip colour: following stops ("PC2 stopped following PC 1"). Type `/follow` and the first letters of PC 1's name, Tab, Enter: following again. `/stop`: it stops.

### Slash commands and timecodes
9. Type `/`: the list shows /timestamp, /follow, /stop, /undo, /redo, /invite, /leave; arrows pick, Tab or Enter completes, Esc closes.
10. Move the playhead, send "check /timestamp": it arrives as your playhead's timecode, a link. Click it on the other PC, also in the collapsed bar: its playhead goes there.
11. `/undo` after a change of yours: it's undone, and "Undid your last change" shows on your PC only. `/invite` on PC 1: the code is copied ("Invite code copied", PC 1 only). A typo like `/folow`: "There's no /folow command", on your PC only.

### Changes
12. PC 1: recolour a clip, then move it, then add a marker. PC 2, **Chat**: three separate grey lines. **Changes**: each with old → new; the filter by person works. Click a change: PC 2's Resolve goes there.

### Urgent cards, leaving, closing
13. Make a lost race (both recolour at once): the loser's orange card pulses 3 times, again after 30 s; **Send mine again** works.
14. PC 2: **⋯ → Leave session**: back to its start card ("You left the session"); PC 1's history gets a dim red "PC2 left". PC 2: **Join** again with the code: it's let in without asking ("PC2 rejoined").
15. PC 1: **⋯ → Leave session** asks "Leave and close the session for everyone?"; **Leave**: PC 1 is back on the start card with **Resume …**; PC 2 gets "PC 1 closed the session" and its start card.
16. PC 1: **Resume**, PC 2 joins with the new code. PC 1: **×** asks Minimize or close, with the host warning; **Minimize** goes back to the bar.
17. PC 2: stop Resolve's bridge: an orange card says sync is paused; start it again: the card goes by itself.

Send me both terminals' output if anything fails.

## Known limits (part 1)
- Windows' acrylic glass covers the whole window, so the urgent cards sit inside the same glass panel as the bar.
- Change lines show timecode from a 01:00:00:00 start (Resolve's default).
- Idle can't tell if someone is just watching: it counts edits, playhead, page and timeline changes and chat.
