# Security review, ResolveCollab 1.0.0 (2026-11-13)

What ResolveCollab trusts, what it doesn't, and how each rule in SPEC §13 and §10.5 is kept. Done by reading every place that takes input from another PC, from the window page, from the screen or from disk (M10 step 8, SPEC §26.1).

## Found and fixed in this review
1. **The host passed ghost-cursor messages on as they came**: any extra fields, up to the 1 MB line limit, to everyone. It now passes on only the checked position and spot (`pointerArrived` returns what it kept).
2. **The host passed "what I have" lists on as they came.** It now passes on only the checked lists: strings of at most 64 characters, at most 50,000 of them.
3. **A source could offer a file of any size** (up to 4 TB) and fill the asker's disk. Now an original must be exactly the size the session recorded, a proxy at most twice its original (or 64 MB), and a download only starts with room for it plus 1 GB; otherwise it pauses with "not enough free space".
4. **A member could ask one PC for the proxies of every clip at once**, which started an ffmpeg per clip at the same time. Proxies are now made one at a time; a waiting asker is told "still making" every 10 s, so it waits instead of giving up.

Each has a test (`src/sessions.test.ts` "the host passes on only what it checked", `src/media/transfer.test.ts` "refuses a file of the wrong size …").

## Who can reach a PC
- **Invite code:** 128 random bits; the Hyperswarm topic is a SHA-256 of it, so the code is never broadcast. Every connection is end-to-end encrypted and authenticated (Noise, via Hyperswarm). A new code every opening (SPEC §22).
- **The host approves every PC** by its lasting public key; removed PCs are blocked and disconnected.
- **A member takes session messages only from the host it joined** (`from === hostId`). Media requests (`media-*`) go straight between PCs; the sender must be an admitted person (host side) or an online person in the host's list (member side).
- **Messages are data, never code.** Every peer message is parsed as JSON and checked before use: operations by `validateOp`/`validateModel`, presence, people, lines, pointers and spots (`cleanPresence`, `cleanPeople`, `cleanLine`, `cleanSpot`), versions (digits and dots only), media lists and offers. A line over 1 MB closes the connection.
- **The bridge in Resolve runs only its own fixed handlers.** The companion turns checked operations into bridge commands; the bridge parses commands with its own decoder and never runs them as code.

## Media files (SPEC §10.5)
- **Only session clips, only to session people:** a request names a session clip ID; the source answers only from its own media pool's file for that clip (never a path from the asker), and only to the people above.
- **Written only inside the project's media folder:** every folder and file name is cleaned (no separators, `..`, characters Windows refuses, reserved names like CON or NUL, trailing dots or spaces, long names), and the final path is checked to be inside the folder.
- **Checked:** each chunk's length and SHA-256; the whole file's SHA-256; an original's fingerprint against the session's; the size limits above. A damaged or wrong file is deleted, never used.
- **Never run by the app.** A received file is only given to Resolve to import, or read by ffmpeg to make a proxy for someone else.

## The window (Electron)
- Both windows (the bar and the cursor overlay): `sandbox`, `contextIsolation`, no `nodeIntegration`, a strict Content-Security-Policy (only the app's own files), navigation and new windows refused. Text from other PCs is shown as text nodes, never as HTML.
- The preload exposes two things: listening on four fixed channels, and sending plain action objects. Electron's main handles a few itself (size, the clipboard with at most 200 characters, file and folder pickers, opening a folder in Explorer, which only ever opens folders); the rest goes to the companion, which checks each action's fields.
- The companion and its window talk over a named pipe with a random 128-bit name, given only to the window.
- **One copy at a time** uses a named pipe per Windows user; anything that connects to it can only ask the running app to bring its window forward.

## Screen reading (ghost cursors, SPEC §24.6.1)
- UI Automation reads only where Resolve's panels are. The capture covers only the timeline's ruler strip and track-name column, only while Resolve or this app is in front. The images stay in memory on this PC; only panel, frame, track and spot are sent. The cursor window is left out of captures.

## On this PC
- **No telemetry.** Nothing is sent anywhere except to session peers. The only other network use is Hyperswarm's public DHT, to find peers.
- **Logs** stay on the PC, one file a day, deleted after 14 days; they hold clip and file names and peer IDs, never media.
- **The installer** is per user, with no admin rights, and unsigned, so SmartScreen warns once. The app writes only its own bridge script into Resolve's Scripts folder. Uninstalling removes the app and that script, and keeps sessions, settings, logs and downloaded media.
- **Ctrl+Z claim** (M7) only while Resolve is in front on Media, Cut or Edit. The mouse watch reads only the left button, the pointer's position and Resolve's window rectangle.
- The bridge's inbox (`%USERPROFILE%\ResolveCollab\inbox`) can be written by any program running as this Windows user; such a program could already do anything this user can.

## Known risks, not fixed
- **No code signing** (SmartScreen warns on install).
- **Resolve and ffmpeg decode files other PCs send.** A person in the session could send a file crafted against Resolve's or ffmpeg's decoders. Only let in people you trust: the host approves each PC.
- **A person in the session can change the shared project**, and can keep a PC busy (for example by asking for many originals). That is what being in a session allows; remove them if needed.
