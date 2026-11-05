# M8 two-PC test, part 2: ghost cursors

Checks SPEC §24.6. Do part 1's "On both PCs (once)" first (`git pull`, `npm install`).

## Run
1. PC 1 hosts, PC 2 joins (as in part 1). Both on the **Edit** page, Resolve in front.
2. PC 1: move the pointer over Resolve. PC 2: an arrow in PC 1's colour moves at the same spot in its Resolve window, smoothly (about 15 times a second). PC 2 does the same: PC 1 sees it.
3. PC 2: put your pointer on PC 1's arrow: PC 1's name shows next to it; move away: it goes. The arrow never fades while PC 1 is still.
4. PC 2: click and drag in Resolve right where PC 1's arrow is: Resolve gets every click (the arrow never gets in the way).
5. PC 1: go to the **Color** page: its arrow goes from PC 2's screen. Back to Edit: it's back.
6. PC 1: click into another program (or the desktop): its arrow goes from PC 2. Click PC 1's chat bar and type: PC 2's arrow on PC 1's screen stays.
7. PC 2: make Resolve's window smaller and move it (or switch to Full Screen Window): PC 1's arrow stays at the same spot relative to the window.
8. PC 1: **gear → Share my cursor** off: its arrow goes from PC 2. On again: back. PC 2: **Show others' cursors** off: PC 1's arrow goes; on: back.
9. PC 2: **⋯ → Leave session**: its arrow goes from PC 1.

Send me both terminals' output if anything fails.

## Known limits
- Positions are relative to Resolve's whole window, so if the two PCs have different panel layouts or window shapes, an arrow is at the same spot of the window, not on the same button.
- Our own window is told apart by its process name ("electron"); a packaged app later will need its own name there.
