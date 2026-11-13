# M10 test: the installed app, on PC 2 and then on both

Checks SPEC §26: the installer on PC 2 (it doesn't use PC 2's Node, so it counts as a clean PC for the app), then a session with the installed app on both PCs. PC 1 already has it installed and checked (§26.2 step 7).

## PC 2: installing
1. Copy `dist\ResolveCollab-Setup-1.0.0.exe` (158 MB) from PC 1 to PC 2 (a USB stick, a network share or a cloud drive). On PC 2, close any ResolveCollab you started from the repo (`node src/companion.ts`).
2. Run it. Windows says "Windows protected your PC": click **More info → Run anyway**. There's no admin password prompt. Leave **Start ResolveCollab** ticked and click **Finish**.
3. The ResolveCollab card opens at the bottom right, with no black console window. The Start menu has **ResolveCollab** with the timeline icon; **Settings → Apps** lists ResolveCollab.
4. The card's hint about Resolve:
   - "ResolveCollab added its script to Resolve. Restart Resolve, then Workspace › Scripts › ResolveCollab." (if Resolve never had the script): do that.
   - "Resolve is running an older ResolveCollab script …": in Resolve, **Workspace → Scripts → ResolveCollab** again.
   - Either way the pill turns green: **Resolve · <project>**.
5. Start **ResolveCollab** from the Start menu again: the same card comes forward; no second one opens.
6. `%USERPROFILE%\ResolveCollab\logs` has today's `companion-<date>.log`.

## Both PCs: a session with the installed app
7. PC 1 hosts (**Resume** or a new session), PC 2 joins with the code. No red version line (both are 1.0.0).
8. Chat both ways; follow each other; ghost cursors move on both, and stay while you type in the chat bar.
9. Recolour a clip on each PC: it changes on the other.
10. PC 1: import a video clip PC 2 doesn't have (a minute or so long) and put it on the timeline. PC 2 gets a proxy by itself, made by the ffmpeg inside the app; then **⋯ → Media → Download original** replaces it.

## Optional: uninstalling (PC 2)
11. **Settings → Apps → ResolveCollab → Uninstall.** The app is gone; after restarting Resolve, Workspace → Scripts no longer lists ResolveCollab; `%USERPROFILE%\ResolveCollab` (sessions, logs) and downloaded media are still there. To keep testing, install it again.

Send me the log files from both PCs (`%USERPROFILE%\ResolveCollab\logs`) if anything fails.
