# M7 two-PC test

Checks SPEC §23: racing edits (first to the host wins, with a notice and `reapply`), undo and redo of your own changes (Ctrl+Z / Ctrl+Shift+Z on the Media, Cut and Edit pages), and Restore mine.

## On both PCs (once)
1. `git pull`, `npm install`, `node tools/install-bridge.ts` (PC 2: `npm.cmd` if PowerShell blocks `npm`).
2. In Resolve: **Workspace → Scripts → ResolveCollab**.
3. PC 1: `node src/companion.ts host` with a test project open (a clip on a timeline). PC 2: `node src/companion.ts join <code>`, PC 1 answers `y`.

## Run
### Racing edits
1. Both PCs: right-click the same clip in the Media Pool → Clip Color, at the same moment (count down together; within about half a second). PC 1 picks **Blue**, PC 2 **Pink**.
   - Both end with the same colour.
   - The PC whose colour was undone says `[n] <other> changed the colour of "<clip>" at the same moment, so your change was undone.  reapply n = send yours again`. The other PC says nothing.
   - If both PCs keep their own colour and nobody is told, you weren't close enough: try again.
2. On the PC that was told: type `reapply <n>`. Its colour now shows on both.
3. Same moment again, but PC 1 changes the clip's **name** and PC 2 its **colour**: both changes are kept, nobody is told.

### Undo and redo
4. PC 2: change the clip's colour (say Green). Then, with Resolve in front on the Edit page, press **Ctrl+Z**: the colour goes back on both PCs. **Ctrl+Shift+Z**: Green again on both.
5. PC 1: change the clip's colour (Orange). PC 2: Ctrl+Z. PC 2's companion asks `PC 1 has since changed the colour of "<clip>". Undo anyway?` Answer `y`: the colour before PC 2's Green comes back on both.
6. PC 2: go to the **Color** page and press Ctrl+Z: that's Resolve's own undo (nothing synced changes). Back on the Edit page, Ctrl+Z is the companion's again.
7. PC 2: delete a timeline marker, then Ctrl+Z: it comes back on both PCs.

### Restore mine
8. PC 2: close its companion (Ctrl+C). PC 2: rename the clip to `mine`. PC 1: rename it to `theirs`.
9. PC 2: join again; answer `m` (keep mine) to the name question. Both now show `mine`.
   - PC 1 says `[n] PC2's offline changes replaced your name on "mine".  restore n = put yours back`.
10. PC 1: `restore <n>`: `theirs` on both.

Send me both companions' output if anything fails.

## Known M7 limits
- Resolve's **Edit ▸ Undo** menu still uses Resolve's own undo, which can take back other people's changes.
- Ctrl+Z while typing in a Resolve text box on the Media, Cut or Edit page goes to the companion.
- The host remembers who changed what only since its companion started: just after the host restarts, an edit racing one made before the restart isn't caught.
