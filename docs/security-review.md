# Security review, v1.0.0 (2026-11-05)

What ResolveCollab trusts, what it doesn't, and how each rule in SPEC §13 and §10.5 is kept. Reviewed by reading every place that takes input from another PC, from the window page, or from disk.

## Who can reach a PC
- **Invite code:** 128 random bits; the Hyperswarm topic is a SHA-256 of it, so the code is never broadcast. Every connection is end-to-end encrypted and authenticated (Noise, by Hyperswarm).
- **The host approves every PC** (by its lasting public key); removed PCs are blocked and disconnected. A member only takes session messages from the host it joined (`from === hostId`); a stranger answering as the host is ignored (tested).
- **Messages are data, never code.** Every peer message is parsed as JSON and checked before use: operations through `validateOp`/`validateModel`, presence, people, lines, pointers and spots (`cleanPresence`, `cleanPeople`, `cleanLine`, `cleanSpot`), names (`cleanName`). The bridge runs only its own fixed handlers, each checking its arguments.

## Found and fixed in this review
1. **The host relayed ghost-cursor messages as they came** (any extra fields, up to the 1 MB line limit, to everyone). It now relays only the checked position and spot.
2. **The host relayed "what I have" lists as they came.** Now only strings of at most 64 characters, at most 50,000 of them.
3. **A source could offer a file of any size** (up to 4 TB) and fill the asker's disk. Now: an original must be exactly the session's recorded size; a proxy at most twice its original (or 64 MB); and nothing downloads without that much free space plus 512 MB.

## Media files (§10.5)
- **Only session clips, only to session people:** a request names a session clip ID; the source answers only an admitted person (host) or an online person in the session (member), and only from its own media pool's file for that clip, or its own stand-in proxy. Nothing the asker sends names a path.
- **Written only inside the project's media folder:** every folder and file name is cleaned (no separators, `..`, characters Windows refuses, reserved names like CON or NUL, trailing dots or spaces, long names), and the final path is checked to be inside the folder (`mediaPath`, `inside`; tested with `..\..\evil.exe`).
- **Checked:** each chunk's SHA-256 and length; the whole file's SHA-256; an original's fingerprint against the session's. A damaged or wrong file is deleted, not used.
- **Never executed or opened by the app.** ffmpeg and ffprobe only read originals from this PC's own media pool. A received file is only given to Resolve to import.
- **Residual risk:** Resolve decodes received proxies and originals. A peer in the session could send a file crafted against Resolve's decoders. Only let in people you trust; the host approves each PC.

## The window (Electron)
- Both windows: `sandbox`, `contextIsolation`, no `nodeIntegration`, a strict Content-Security-Policy (only the app's own files), navigation and new windows refused. The page shows peers' text as text nodes only (no HTML from anyone).
- The preload exposes two functions: listen on four fixed channels, and send plain action objects. Electron's main handles a few itself (size, clipboard of 200 characters, file and folder pickers, opening the media folder: only an existing directory) and passes the rest to the companion, which checks them like any input.
- The companion and the window talk over a named pipe with a random 128-bit name, given only to the window.

## Screen reading (ghost cursors, §24.6.1)
- UI Automation reads only Resolve's panel positions; the capture covers only the timeline's ruler strip and track-name column, only while Resolve or this app is in front. Images stay in memory on this PC; only panel names, frames, tracks and spots are sent. The cursor window is excluded from captures.

## Local
- **No telemetry.** Nothing is sent anywhere except to session peers. The only other network use is Hyperswarm's public DHT to find peers.
- **Logs** stay on the PC, one file a day, deleted after 14 days; they hold clip and file names and peer IDs, never media. **Export diagnostics** zips them into Downloads only when the person clicks it.
- **Installer:** per user, no admin rights. Unsigned, so SmartScreen warns once. Uninstalling removes the app and the bridge script from Resolve, and keeps sessions and downloaded media.
- **Ctrl+Z claim** (M7) only while Resolve is in front on Media, Cut or Edit; mouse watch reads only the left button, the pointer's position and Resolve's window rectangle.

## Not covered (known)
- Code signing (SmartScreen warns).
- A malicious host can of course change the shared project; that is what a session is.
- Bundled ffmpeg is the build given to `tools/build-release.ts` (by default the one on the building PC: the GPL "essentials" build). The LGPL build the spec asks for needs to be passed with `--ffmpeg`; the proxy maker uses Windows' H.264 encoder with it.
