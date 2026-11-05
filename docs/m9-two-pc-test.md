# M9 two-PC test: media

Checks SPEC §25: missing clips get a proxy by themselves, the original on request, the Media panel, the Deliver warning, resuming a download, Locate file.

## On both PCs (once)
1. Close any companion. `git pull`, `npm install` (PC 2: `npm.cmd install`), `node tools/install-bridge.ts`.
2. In Resolve: **Workspace → Scripts → ResolveCollab** (start it again: the bridge changed).
3. PC 1 makes the proxies, so it needs ffmpeg (it has it). PC 2 doesn't, unless it should make proxies for others too: `winget install Gyan.FFmpeg.Essentials`.

## Set up on PC 1
4. A project with, in a bin called `Interviews`, **a video clip PC 2 doesn't have** (a few minutes long is best, to see progress), on a timeline. Also in the media pool: **a sound file** (.wav or .mp3) and **a picture** (.png or .jpg), also not on PC 2.
5. PC 1 hosts; PC 2 joins as usual.

## Run
### Proxies by themselves
6. PC 2: an orange card asks **Where should downloaded media go?** with `…\Videos\ResolveCollab\<project>`. Click **Use this folder**.
7. PC 2: a plain card shows **N clips missing**, "Downloading proxies from PC 1", a bar and a percentage. (First "PC 1 is making a proxy…", for a while for a long clip.)
8. PC 2: the clip appears in the media pool, in `Interviews`, with PC 1's name and colour, and its item on the timeline plays (the proxy: softer picture). The sound file and the picture come as they are.

### The Media panel
9. PC 2: **Show** on the card (or **⋯ → Media**): the folder with space used and free, **Download all originals**, the clip under **Proxies** with **Download original · <size>**, the sound and picture under **Here**. PC 1's panel shows **Sending to others** while it sends.
10. PC 2: **Open folder**: Explorer opens it, with `Interviews\<clip> (proxy).mp4` inside.

### The original
11. PC 2: **Download original**. It shows under **Downloading** with a bar; **Pause** stops it, **Resume** carries on from where it was.
12. When it's done: the clip plays at full quality, still in its bin with its name, colour and timeline item. In Resolve, **Playback → Use Proxy Media** still switches to the proxy (it stays attached).

### Picking up after a break
13. Make a fresh stand-in again (PC 1: add another long clip PC 2 doesn't have; PC 2: wait for its proxy). PC 2: **Download original**, and at about half way close the companion (Ctrl+C). Start it again and **Join** with the code: the download carries on from about half way, not from 0.

### Deliver page
14. PC 2, while a clip is still a proxy: go to the **Deliver** page. An orange card says the render would use proxies, with **Download originals**. **Dismiss** hides it until you come back to Deliver.

### Locate file
15. PC 2, if you have your own copy of a clip that's a proxy: **Locate file…** next to it, pick your copy: it's checked, then the clip plays it. A different file is refused ("is not the same file as …").

Send me both terminals' output if anything fails.

## Known limits
- Each file comes from one PC (the host first); splitting one file across several PCs isn't done.
- The "over 5 GB" question uses an estimate (a proxy is about a fifth of its original).
- A file ffmpeg can't read (Blackmagic RAW and the like) shows "No proxy possible" with Download original.
- ffmpeg isn't bundled yet (M10).
