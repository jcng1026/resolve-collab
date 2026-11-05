# M8 two-PC test, part 2: ghost cursors

Checks SPEC §24.6. Do part 1's "On both PCs (once)" first (`git pull`, `npm install`).

## Run
1. PC 1 hosts, PC 2 joins (as in part 1). Both on the **Edit** page, Resolve in front.
2. PC 1: move the pointer over Resolve. PC 2: an arrow in PC 1's colour moves at the same spot in its Resolve window, smoothly (about 30 times a second). PC 2 does the same: PC 1 sees it.
3. PC 2: put your pointer on PC 1's arrow: PC 1's name shows next to it; move away: it goes. The arrow never fades while PC 1 is still.
4. PC 2: click and drag in Resolve right where PC 1's arrow is: Resolve gets every click (the arrow never gets in the way).
5. PC 1: go to the **Color** page: its arrow goes from PC 2's screen. Back to Edit: it's back.
6. PC 1: click into another program (or the desktop): its arrow goes from PC 2. Click PC 1's chat bar and type: PC 2's arrow on PC 1's screen stays.
7. PC 2: make Resolve's window smaller and move it (or switch to Full Screen Window): PC 1's arrow stays at the same spot relative to the window.
### Different layouts and zoom (SPEC §24.6.1)
A. PC 2: move or resize a panel (drag the line between the media pool and the viewer). PC 1's pointer in its media pool shows in PC 2's media pool, wherever it is now; in the viewer, in PC 2's viewer.
B. PC 2: zoom the timeline in (the + by the zoom slider) so it's zoomed differently from PC 1. PC 1: put the pointer on a clip on V1. On PC 2 the arrow is on the same clip, same spot, on V1; it may take half a second after a zoom.
C. PC 1: drag a clip from its media pool to the timeline. On PC 2 the arrow goes from PC 2's media pool to the place on PC 2's timeline where the clip lands.
D. PC 2: zoom in a lot, so PC 1's pointer is at a time PC 2 can't see. PC 2: the arrow waits at the timeline's edge with "→ 01:00:…" (or "← …"); scroll there: it's on the spot.
E. PC 2: hide the inspector (Inspector button, top right). PC 1: pointer over its inspector: no arrow on PC 2 (it has nowhere true to go).

8. PC 1: **gear → Share my cursor** off: its arrow goes from PC 2. On again: back. PC 2: **Show others' cursors** off: PC 1's arrow goes; on: back.
9. PC 2: **⋯ → Leave session**: its arrow goes from PC 1.

Send me both terminals' output if anything fails.

## Known limits
- Inside the media pool and other panels, an arrow is at the same spot of the panel, not on the same clip or button (their sort, scroll and size can differ).
- Only the Edit page's timeline is read by frame and track; on the Cut and Fairlight pages the timeline is a panel like the others.
- A track is found by its name on screen; a track whose name can't be read (too short to show it, or renamed to something two tracks share) uses the spot in the timeline instead.
- The cursor window is left out of screen captures and recordings (so reading the ruler can't read the arrows back).
- Our own window is told apart by its process name ("electron"); a packaged app later will need its own name there.
