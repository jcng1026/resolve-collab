# M10 test: installing on a clean PC

Checks SPEC §26 on a PC that has never had the repo, Node or ffmpeg (PC 2 is fine if you first uninstall nothing: the installed app doesn't use the repo).

## Build (PC 1)
1. `git pull`, `npm install`, then `node tools/build-release.ts`. It makes `dist\ResolveCollab-Setup-1.0.0.exe` (about 175 MB).
   (For the LGPL ffmpeg the spec asks for: download BtbN's `ffmpeg-n9.0-latest-win64-lgpl-9.0.zip`, unzip it, and add `--ffmpeg <unzipped>\bin`.)
2. Copy the installer to PC 2 (USB stick, shared folder, or send it).

## Install (PC 2)
3. Close any companion running from the repo. Run the installer. SmartScreen: **More info → Run anyway**. No admin password is asked. Leave **Start ResolveCollab** ticked, **Finish**.
4. The ResolveCollab card opens at the bottom right; no black console window. Its log says the bridge was installed into Resolve.
5. In Resolve: **Workspace → Scripts → ResolveCollab** (restart Resolve first if it isn't listed). The card's pill turns green: **Resolve · <project>**.
6. Start ResolveCollab again from the Start menu while it runs: nothing new opens (one companion only).

## Use it
7. Do a short session with PC 1 (PC 1 can run from the repo or the installer): join, chat, a colour change syncs, a missing clip arrives as a proxy (made by the bundled ffmpeg if PC 2 hosts).
8. If PC 1 runs a different version, both see a red line saying so.
9. **Settings (gear) → Export diagnostics**: Explorer opens Downloads with `ResolveCollab-diagnostics-<time>.zip`, holding `logs\` and `info.json` (ResolveCollab 1.0.0, Resolve's version, the bridge build, ffmpeg in the app folder).

## Uninstall
10. **Settings → Apps → ResolveCollab → Uninstall**. The app folder and Resolve's `ResolveCollab` script are gone (after restarting Resolve it's not in Workspace → Scripts). `%USERPROFILE%\ResolveCollab` (sessions) and `Videos\ResolveCollab` (downloaded media) are kept.

Send me the diagnostics zip if anything fails.

## Known limits
- Unsigned (SmartScreen warns once). No auto-update: install the new version on every PC.
- The default build bundles the building PC's ffmpeg (GPL); pass the LGPL build with `--ffmpeg` for the spec's licence.
