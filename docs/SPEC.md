# ResolveCollab — Specification

Status: **Draft for review** · Version 0.1 · 2026-11-02

ResolveCollab lets up to 5 people edit the same DaVinci Resolve project together over the internet, seeing each other's changes within about 1–2 seconds and each other's playheads and cursors live. It is a personal tool, built from scratch on Resolve's public scripting API. It does not reverse-engineer or modify Blackmagic's own collaboration system.

---

## 1. Goals and non-goals

### Goals
- Live sync of project content between up to 5 peers, peer-to-peer, no paid server.
- Works on **genuine DaVinci Resolve Free 21.1+ and Studio 21.1+**, on Windows.
- Presence: see where everyone is (playheads, current clip, page) and their mouse pointers.
- Never silently lose anyone's work: backups before risky operations, explicit choices on conflicts.
- Missing media is detected and fetched directly from a collaborator, proxy first.

### Non-goals
- Linux and macOS (may come later; nothing in v1 is tested there).
- Supporting, testing or debugging cracked or modified Resolve builds. Only genuine Free and Studio are supported.
- Unlocking Studio features in the Free version.
- Syncing anyone's personal settings (see §6.3).
- A central server, accounts, or cloud storage.
- Code signing and auto-update (v1).

---

## 2. Platform and requirements

| Item | Requirement |
|---|---|
| OS | Windows 10/11, 64-bit |
| Resolve | Genuine Free 21.1+ or Studio 21.1+. Peers on different Resolve versions get a warning but are allowed in |
| Peers | 2–5 per session. A 6th join request is refused |
| Network | Ordinary home internet. No port forwarding required |
| Sync delay | Edits: 0.5–2 s. Presence (playheads, cursors): near-instant |

---

## 3. Architecture

```
┌──────────────────────── One peer's PC ────────────────────────┐
│ DaVinci Resolve                                                │
│   └─ ResolveCollab bridge (Lua, started via Workspace▸Scripts) │
│         ▲ request files (data only)   │ responses (Fusion prefs)│
│         │                             ▼                        │
│ ResolveCollab companion app (TypeScript / Electron)            │
│   • Sync engine (host-ordered operation log + reconciler)      │
│   • Session / host logic, locks, undo, merge                   │
│   • Companion window (people, chat, media, status)             │
│   • Overlay window (ghost cursors, playhead tags)              │
│   • Media service (hashing, proxies via bundled ffmpeg,        │
│     transfer)                                                  │
└───────────────────────────────┬────────────────────────────────┘
                                │ Hyperswarm (P2P, Noise-encrypted)
                     other peers' companion apps
```

### 3.1 Components
- **Bridge (Lua):** runs inside Resolve. It reads the project through the API, takes snapshots, and applies commands. It contains a fixed set of command handlers. It **never executes code received from the network**.
- **Companion app (TypeScript + Electron):** everything else. One per PC.
- **Network:** Hyperswarm. Peers find each other through the public DHT using a topic derived from the session secret. All traffic is end-to-end encrypted (Noise). No server to run or pay for.
- **Shared state:** the host's model of the project plus the ordered operation log that produced it (§19.2). Yjs was dropped on 2026-11-02: it merges conflicting edits by itself, which contradicts first-to-host-wins (§5) and the merge dialogs (§9.3).
- **ffmpeg:** bundled, used only for proxies and media inspection.

### 3.2 Bridge ↔ companion channel
Resolve Free 21.1 Lua has no sockets or general file I/O. Measured on Free 21.1.2 for Windows (`docs/feasibility/findings-2026-11-02.md`):
- **Bridge → companion (works):** the bridge runs `fusion:Execute('error("RCFEAS|<key>|<hex>")')`. Resolve writes each error to `Support/logs/ResolveDebug.txt` immediately and the bridge keeps running. The companion follows the log. Payloads are hex and split into ≤1500-character chunks, because log lines are cut at ~2000 characters. Throughput: 200 messages in 17 ms, in order.
- **Companion → bridge (approved 2026-11-02):** `loadfile`, `dofile`, `io`, `bmd.readfile` and `fusion:LoadPrefs` are all nil, so the bridge can't read request files. Instead, the companion creates **subfolders in an inbox folder whose names are the messages** (`<seq>_<hex payload>`). The bridge reads them with `resolve:GetMediaStorage():GetSubFolderList(inbox)`: 100 messages in ~33 ms. Each listing makes Resolve's Media Storage browser jump to the inbox and empties the Metadata panel (found 2026-11-03). So the companion also creates a `<seq>.ready` folder once a message is complete. The bridge checks only for the next one, with `bmd.direxists`, which has no side effects, and lists the inbox only when it's there. The bridge acknowledges the highest sequence it has handled through the error log, and the companion then deletes those folders. Large payloads are split across several folders.
  - Inbound messages stay **data only**: decoded by the bridge's own parser, never executed.
  - *Superseded:* the keyboard-preset trick (the bridge can't know the file name it would have to import) and the OTIO timeline trick (switches the editor's current timeline).
- *Rejected:* `Fusion.prefs` via `SetPrefs`/`SavePrefs`. `SavePrefs` doesn't exist on Free, and the file is only written when Resolve restarts.
- **Protocol:** every request has a sequence number, a command, arguments and a timeout. Every response echoes the sequence number, plus a status (`ok` / `error` / `unsupported`) and its data. Requests older than 120 s are refused.
- **Liveness:** the bridge writes a heartbeat key every second. No heartbeat for 3 s means the bridge is not running (§9.4).

### 3.3 Change detection
- The API sends no change events, so the bridge **snapshots** the session project about every 300 ms and the companion diffs consecutive snapshots.
- Snapshot cost must be measured. Large projects may need incremental snapshots (open timeline every tick, other timelines and bins less often).
- A change the bridge itself applied on behalf of others is tagged, so it isn't mistaken for a local edit.
- Each detected local change becomes an **operation**, for example `clip.trim`, `clip.move`, `marker.add` or `bin.rename`, sent to the host.

### 3.4 Object identity
The same clip has different internal IDs on each PC. The companion keeps a mapping from a **collab ID** (a random ID chosen by whoever creates the item) to each PC's local object:
- Media pool clips: the collab ID is stored in the clip's third-party metadata (`rcId`). Verified on Free: it survives save + reopen and `.drp` export + import (§19.1).
- Bins: no metadata, so mapped by the bin's local unique ID, saved by the companion. After a `.drp` import, mapped by bin path.
- Timeline items: map the local unique ID to the collab ID. Rebuild the mapping by matching (track, record position, source media, source in/out) after a timeline swap or rebuild.

### 3.5 Applying remote changes: three tiers
Each bridge reports at startup which API calls work on its Resolve (a capability probe). For each incoming operation, the peer uses the best tier available to it:

| Tier | Method | Typical time | Notes |
|---|---|---|---|
| 1 Direct | The matching API call | Instant | Some calls (for example trims) may be Studio-only |
| 2 Rebuild clip | Read every property of the item → delete → re-append with the new in/out/position → restore properties, markers, Fusion comp | ~1 s | Only if every property can be read back |
| 3 Timeline swap | A peer that can apply the edit exports the timeline as `.drt`; this peer imports it and swaps it in, keeping the playhead position | A few seconds | Grouped at most once every 2 s |

No edit is ever blocked because a peer is on Free. Free peers may just receive some edits a little later.

---

## 4. Session model

### 4.1 Roles
- **Host:** the person who created the session. They are the referee: they decide the order of all operations and who holds each lock, and they store the session state and chat. **The session belongs to its host.** There is no hand-over to another peer.
- **Members:** all equal editors. The host can also remove members.
- Viewer role: v2, only if needed.

### 4.2 Starting and joining
1. The host opens their Resolve project, starts the bridge, and clicks **Start session** in the companion. They get an **invite code**, which they share however they like (WhatsApp, Discord, …).
2. A joiner enters the code. The **host approves each join request** (shown with the joiner's name).
3. A new joiner receives the project as a `.drp`, imported as a normal project in their library named `<Project> (collab · hosted by <Host>)`, then goes live.
4. A joiner who already has a copy of this session's project only receives the changes they missed (§9).

### 4.3 Host connection lost vs host leaving
- **Host connection lost:** members switch to offline mode (§9.1) and retry for up to **10 minutes**. If the host returns, everyone reconnects and merges automatically.
- **Host ends the session, closes the app, or the 10 minutes pass:** the session ends for everyone. Members keep their local copies. Any queued changes are kept locally and flagged as **not synced to the host**.

### 4.4 Resuming another day
- **Only the host** can reopen their session, with the **same invite code**. Members rejoin with that code and catch up (§9).
- The host can **end the session permanently**. The invite code becomes invalid and the session's chat history is deleted.
- If the host's PC is gone for good, anyone can **start a new session from their own copy**. People who join it with an older copy get that copy backed up, then replaced with the new host's version.

### 4.5 Removing a member
The member is disconnected and their invite access revoked. They need a new code to rejoin. Their local project copy and downloaded media stay on their PC.

---

## 5. Concurrency: locks and conflicts

- A **lock** exists only while a change to an item is being sent and applied (about 1 s). The host grants it, and it is released as soon as every peer has applied the change.
- If two people change the same item at nearly the same time, **the change that reaches the host first wins**. The other person's change is undone on their PC, with a notice: *"Alex changed this clip at the same moment — your change was undone."* plus a **Reapply** button. Reapply sends it again as a new edit.
- No warning-before-editing layers and no manual claiming of clips (both considered and rejected).

---

## 6. What syncs

### 6.1 v1
| Area | Includes |
|---|---|
| Media pool | Bins (create, rename, move, delete), clips (import, move, rename), clip metadata, clip colour |
| Timelines | **All timelines** in the project: create, rename, duplicate, delete (delete asks to confirm and makes a backup first); tracks; clips: add, delete, move, trim, enable/disable, properties the API exposes (transform, crop, composite, speed, volume…) |
| Markers | Timeline and clip markers: add, edit, delete, colour, name, note |

### 6.2 v2, in this order
1. **Color:** the whole grade is copied (DRX-style). It syncs when the grader moves to another clip or leaves the Color page, or when they click **Sync grade now**. While someone grades a clip, others see "Sam is grading this".
2. **Fusion:** comps per timeline item.
3. **Fairlight:** as far as the API allows (expected to be clip-level volume and similar).
4. Optional viewer role.

### 6.3 Never synced (personal)
Window and panel layout, playhead position, timeline zoom and scroll, viewer and monitoring settings, cache, render and export settings, Resolve preferences, which project is open.

---

## 7. Undo (Ctrl+Z)

- While Resolve is the active window, the companion **intercepts Ctrl+Z and Ctrl+Shift+Z** and undoes or redoes **only your own** changes, by sending the inverse operation.
- History: your **last 100 changes**, kept for the session and **saved across reconnects**.
- If someone else has changed that item since, it asks first: *"Alex has since changed this clip — undo anyway?"*
- A batch merged after offline or bridge-off time (§9) counts as **one** undo step.
- Known limitation: Resolve's own **Edit ▸ Undo** menu bypasses ResolveCollab. If it undoes a synced change, the app detects this and re-syncs.

---

## 8. Presence

- **Semantic presence:** each person's current page, timeline, playhead timecode and clip under the playhead, shown as coloured playhead tags with names.
- **Follow:** a button that jumps your page, timeline and playhead to a chosen person.
- **Ghost cursors:** each person's mouse position, relative to their Resolve window, drawn as a coloured pointer in a click-through overlay on your Resolve window. It is only accurate when layouts are similar, so Follow helps.
- **Per-user toggles:** ghost cursors, playhead tags and name tags can each be turned on or off. Everyone sets their own name and colour, which is remembered between sessions.

---

## 9. Offline, bridge-off and catch-up

### 9.1 Offline (internet or host lost)
A banner says **"Offline — changes won't sync"**. You can keep editing, and changes are queued. On reconnect, the merge in §9.3 runs.

### 9.2 Bridge not running or a different project open
- **Bridge not running** (forgot to start it, or Resolve restarted): a large banner says **"Sync paused — start ResolveCollab in Resolve"**. When the bridge starts, it compares the project with the last state it knew, and the merge in §9.3 runs.
- **A different project open in Resolve:** sync pauses with *"You switched to another project — switch back to resume."* Nothing from the other project is ever sent.

### 9.3 Merge rules (same everywhere)
Three versions are compared for each item: the **last version everyone agreed on**, **yours now**, and **the session's now**.
1. A **backup `.drp`** of your project is saved first.
2. Items only you changed are sent to everyone.
3. Items only others changed are applied to your copy.
4. Items you both changed:
   - **Different properties** (you changed volume, Alex trimmed): both are kept automatically.
   - **Same property:** dialog with **Keep mine / Keep Alex's**, one decision per item, plus **Apply to all remaining**.
   - **Deleted on one side, edited on the other:** always asks, *Keep it / Delete it*. A deletion never wins silently.
   - **Media you used was deleted from the media pool:** asks whether to restore it for everyone or remove your clips that use it.
5. The dialogs are shown **only to the returning person**. Nothing is sent until they've answered all of them, and meanwhile they appear as "reviewing changes" to others, who keep working normally.
6. If several people changed an item while you were away, you see the session's **latest** version and its author.
7. If you pick **Keep mine** over someone's work, **that person** gets a non-blocking notice: *"Sam's offline changes replaced your trim on 'Interview_03' (Timeline 1) — Show / Restore mine."* **Restore mine** is a normal new edit (first-to-host rule), so dialogs can't loop.

---

## 10. Media

### 10.1 Identifying files
Files are matched by **name + size + partial hash** (first and last few MB plus a sample from the middle), never by folder path, since paths differ between PCs.

### 10.2 Missing media
When a peer lacks media used in the session, the companion shows a list of missing files with, for each one:
- **Download proxy** (default), then **Download original** on demand.
- **Locate file…**: the user points to their own copy. It's checked by fingerprint, then relinked.

Every peer can download the originals and export at full quality.

### 10.3 Proxies
The companion makes proxies itself with **bundled ffmpeg**: H.264, half resolution, max 1080p, AAC audio (playable by Free on Windows). Whoever holds the original makes the proxy, on demand, and caches it.

### 10.4 Transfer
- Directly peer-to-peer over the session connection, in chunks with resume. A file is fetched from **several peers at once** when more than one has it.
- Every chunk and the final file are verified by hash.
- Files are saved to a **per-project media folder**, asked once, default `Videos\ResolveCollab\<Project>\`, mirroring the host's folder structure. Free disk space is shown before downloading.
- After download, the bridge relinks the clip (original) or attaches the proxy.

### 10.5 Safety rules
- A peer can only request files that the session's media pool actually references.
- Received files are written **only inside the project's media folder**. Names are sanitised, so no `..`, absolute paths or reserved Windows names.
- Received files are never executed or opened by the app (ffmpeg only reads files the user's own app created or verified).

---

## 11. Chat

- A simple text chat in the companion window.
- Typing a timecode such as `01:02:14:05` creates a link that jumps the clicker's playhead there (on the sender's timeline).
- History is stored on the host, sent to joiners and rejoiners, and deleted when the host ends the session permanently.

---

## 12. Companion window and installer

### 12.1 Companion window
A small window docked beside Resolve:
- **People:** name, colour, status (live / offline / reviewing changes / bridge paused), Follow button. The host also sees Remove.
- **Session:** start, join, invite code, end.
- **Chat.**
- **Media:** list of missing files, downloads in progress.
- **Status bar:** sync state, bridge state, version warnings.
- **Settings:** name, colour, overlay toggles, media folder.

### 12.2 Installer
- A Windows installer (`.exe`), unsigned. Windows SmartScreen will warn, and the user clicks "More info → Run anyway".
- It installs the app, bundled ffmpeg, and the bridge script into `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\` (path to be verified on genuine 21.1).
- No auto-update. Peers on different ResolveCollab versions see a warning.

---

## 13. Security and privacy

- Invite code = a high-entropy secret. The Hyperswarm topic is derived from it, so the code itself is never broadcast.
- The host approves every join. Removed members' access is revoked.
- All peer traffic is end-to-end encrypted (Noise, via Hyperswarm).
- Peers exchange **operations (data)**, never code. The local companion validates every operation before turning it into a bridge command. The bridge only runs its own fixed handlers.
- File transfer rules: §10.5.
- No telemetry. Nothing is sent anywhere except to session peers.

---

## 14. Diagnostics

- Each PC keeps a local log, deleted after 14 days. Logs never contain media content.
- **Export diagnostics** zips the logs, ResolveCollab version, Resolve version and edition, and the capability probe results, for sharing with whoever is debugging.

---

## 15. Open technical risks: the feasibility test must answer these

The feasibility test runs in a throwaway project in genuine Resolve Free 21.1.2 on Windows. Results as of 2026-11-02 (details in `docs/feasibility/findings-2026-11-02.md`):

| # | Question | Result |
|---|---|---|
| F1 | Bridge loop runs with Resolve responsive; bridge can read request files | Loop **yes** (52 ms worst gap). Reading files **no**; listing subfolder names works instead (§3.2) |
| F2 | Outbound channel | `Fusion.prefs` **no**; error log via `fusion:Execute` **yes** (§3.2) |
| F3 | Script install path | `%APPDATA%\…\Support\Fusion\Scripts\Utility\` **yes**; `.py` not listed on Free. Don't put shared files under `%LOCALAPPDATA%` when started from a packaged app |
| F4 | Timeline / media pool edits on Free | **All needed edits work**, including trims, moves, track changes. Bins have no `Folder.SetName`, but a rename can be emulated (§19.1). `ImportMedia` only accepts plain paths |
| F5 | Item state readable | **Yes** |
| F6 | `.drt` export/import | **Yes** |
| F7 | `.drp` export/import | **Yes** |
| F8 | Presence reads | **Yes**, including selected clips |
| F9 | Media relinking | `LinkProxyMedia`, `ReplaceClip` **yes**; `RelinkClips` to recheck with an offline clip |
| F10 | IDs and metadata | **Yes** (`GetUniqueId`, third-party metadata, marker `customData`) |
| F11 | Snapshot cost, 300 items | 101 ms light, 590 ms full, so snapshots must be incremental |
| F12 | Writes persist | Mostly. **Fades and added Fusion comps were lost after save + reopen** despite returning `true`, so read-back after save is required |

Risks the feasibility test can't cover, tested later:
- Ctrl+Z interception and Resolve's own shortcuts.
- The overlay above a full-screen Resolve.
- Hyperswarm connection success on the users' home networks.
- Blackmagic closing the Lua route in a future update. This risk is accepted: watch release notes, and pin the Resolve version if needed.

---

## 16. Build plan and definition of done

Every feature follows: spec section → automated tests (using a **fake bridge** recorded from the feasibility results, and a **5-peer network simulator** with delay, reordering and cuts) → code → review against this spec → manual checklist on two genuine Resolve Free PCs → commit.

| Milestone | Done when |
|---|---|
| M0 Setup | Repo at `C:\dev\resolve-collab` (private GitHub), Node installed, CLAUDE.md, test framework runs |
| M1 Feasibility | F1–F12 answered on genuine Free 21.1 (Windows) and committed to the repo; spec updated |
| M2 Thin end-to-end | On 2 PCs: adding a clip on one appears on the other within 2 s |
| M3 Media pool | §6.1 media pool items sync both ways, including offline merge |
| M4 Timelines | §6.1 timeline items sync across all tiers, on Free↔Free and Free↔Studio |
| M5 Markers | §6.1 markers sync |
| M6 Sessions | §4 complete: invite, approval, removal, host drop and grace period, resume, new session from copy |
| M7 Locks, undo, merge | §5, §7, §9 complete, proven by simulator tests including 5 peers |
| M8 Presence and chat | §8, §11 complete |
| M9 Media | §10 complete including safety rules |
| M10 Release v1 | Installer works on a clean PC; security review passed; diagnostics export works |
| v2 | Color → Fusion → Fairlight → viewer role |

---

## 17. Decision log (summary)

| Topic | Decision |
|---|---|
| Approach | Build from scratch on the public API; don't reverse-engineer Blackmagic collaboration |
| Licensing | Genuine Free/Studio only; cracked builds are not supported, tested or debugged |
| Platform | Windows only (Linux dropped for now) |
| Host | Creator owns the session; no hand-over; only the host resumes |
| Host drop | 10-minute grace in offline mode, then the session ends |
| Conflicts | First change to reach the host wins; loser undone with notice + Reapply |
| Locks | Only while a change is in flight |
| Undo | Own changes only, 100 steps, persisted, asks if someone edited since |
| Offline merge | Three-way; backup first; dialogs only for the returning person; overwritten person notified |
| Media | Proxy first, original on demand, or locate manually; P2P from whoever has it |
| Proxies | Bundled ffmpeg, H.264 half-res, max 1080p |
| Personal settings | Never synced |
| Roles | Equal editors + host can remove; viewer role in v2 |
| Chat | Yes, with timecode links; stored on host |
| Install | Unsigned installer that also installs the bridge; no auto-update |
| Diagnostics | Local logs (14 days) + Export diagnostics; no telemetry |
| Name | ResolveCollab |
| Bridge → companion | Errors raised in `fusion:Execute`, read from `ResolveDebug.txt` (§3.2) |
| Companion → bridge | Subfolder names in an inbox, read with `MediaStorage:GetSubFolderList` only after `bmd.direxists` finds the next `<seq>.ready` folder (§3.2) |
| Shared state | Host-ordered operation log, not Yjs (2026-11-02) |
| Merge questions before the companion window exists | Asked in the companion's terminal |
| Media pool deletes | Sync live; the host keeps deleted items so undo (M7) can restore them |
| Joining before `.drp` transfer (M6) | Match and combine: matching bins and clips are linked, the rest is added on both sides |

---

## 18. M2 design: thin end-to-end

Goal: on two PCs, a clip appended to the current timeline on one appears on the other within 2 s. Everything else waits for later milestones.

### 18.1 Bridge wire format
- **Outbound log line:** `RC|<bridgeId>|<kind>|<hex(JSON)>`, raised through `fusion:Execute('error("…")')`. `bridgeId` is random per bridge start, so lines from older runs are ignored. Kinds:
  - `HELLO` (product, version, Studio flag, inbox)
  - `HB` (heartbeat, every 1 s; carries `handled`, see §19.4)
  - `ACK` (highest inbox sequence handled)
  - `EVT` (detected local change)
  - `RES` (result of a command)
  - `ERR` (error)
  - Long payloads are split into `<kind>` parts carrying `{part, parts, msg}`.
- **Inbox folder:** `<seq:8 digits>.<part:3>.<parts:3>.<hex(JSON chunk)>`, ≤ 100 payload bytes per folder. The companion deletes folders up to the acknowledged sequence.
- **JSON only, both ways.** The bridge has its own small JSON decoder. Inbound text is never passed to `loadstring` or `Execute`.

### 18.2 Commands and events (M2 subset)
- **Event** `clip.added`: `{timeline, track, start, end, srcStart, srcEnd, media:{name, path, frames}}`. Detected by snapshotting video track items of the current timeline every 300 ms and comparing unique IDs. Items the bridge added itself are excluded.
- **Command** `clip.append`: same fields. The bridge finds the media pool item by file name (fingerprints come in M9), then calls `AppendToTimeline` with `recordFrame` and `trackIndex`. It replies with `RES {seq, ok, error?}`.
- If the media isn't in the receiver's media pool, the reply is `RES {ok:false, error:"media-missing"}`. Media transfer is M9.

### 18.3 Peers
- **Transport:** Hyperswarm, topic = SHA-256 of the invite secret. Connections are Noise-encrypted by Hyperswarm.
- **Messages:** newline-delimited JSON.
- **Delivery:** every message is numbered, acknowledged, resent every 0.5 s until acknowledged (dropped after 10 s), and de-duplicated by the receiver. This is needed because Hyperswarm often opens a duplicate connection and closes one of the pair a moment later, and anything written to the closed one is lost. While a peer has no connection, it re-runs the topic lookup every 3 s, since peers joining at the same moment otherwise wait minutes for Hyperswarm's own refresh.
- **M2 scope:** two peers, no host approval, no ordering or locks. Those come in M6/M7.

### 18.4 Verification
- Unit tests: protocol encoding (TS), the Lua bridge's codec run under `fuscript`, and a companion pipeline against a fake bridge.
- On one PC: real bridge ⇄ companion A ⇄ Hyperswarm ⇄ companion B ⇄ second bridge simulated by a fake.
- Final check: the user's two PCs (`docs/m2-two-pc-test.md`).

### 18.5 Status (2026-11-02)
- One-PC check passed with genuine Resolve Free 21.1.2:
  - Peer → Resolve: a clip from companion B was applied in Resolve **~125 ms** after B detected it.
  - Resolve → peer: a clip appended in Resolve was received and applied by B **62 ms** after the bridge detected it (detection polls every 300 ms).
  - Clips the bridge added were not echoed back.
  - The bridge stopped cleanly on a `stop` command.
- Re-checked after adding acknowledged delivery, over the public network: ~127 ms peer → Resolve, 65 ms Resolve → peer. Hosting took ~13 s to announce, and joining connected in ~4 s.
- **Two-PC check passed (M2 done):** two Windows PCs on genuine Resolve Free 21.1.2, over the public network, joined with an invite code.
  - Three clips were synced: one from PC 1 to PC 2, and two from PC 2 to PC 1. Each landed at the sender's position on V1.
  - The media sat at a different path on each PC (`…\jcng7\Downloads` and `…\moeyn\Downloads`) and was matched by file name.
  - Applying a clip in Resolve took 161–499 ms.
  - The two PCs' clocks differ by ~85 s, so one-way time can't be read off directly. Adding the two directions gives ~0.94 s for a round trip, i.e. **~0.5 s from detection to applied**, comfortably under the 2 s target.
  - There were no echoes.
- Deviations from §18.1: payloads over ~750 bytes are reported as `ERR payload-too-large` instead of split (none occur in M2). A second bridge run takes over from the first through an in-memory `SetPrefs` key.

---

## 19. M3 design: media pool

Goal (§16): bins and clips sync both ways, live and after offline or bridge-off time, on Free. Applies decisions from 2026-11-02 (§17).

### 19.1 What Resolve Free allows (probe, `docs/feasibility/findings-2026-11-02.md`)
- Create, move and delete bins; import into a chosen bin (set the current bin, import, set it back); move, rename, recolour, flag and delete clips; set metadata and third-party metadata. All read back correctly.
- **Bin rename** has no API. It is emulated on the receiving PC: make a bin with the new name next to the old one, move its clips and sub-bins into it, delete the old one. The receiving bin gets a new local ID; the clips keep theirs.
- **Missing files** can't be imported (no offline placeholder), so a clip whose file this PC lacks is listed as missing (§19.6) and added once the file is found.
- Deleting a pool clip leaves its timeline uses in place.
- Snapshot cost is ~0.9 ms per clip, so the pool is scanned incrementally (§19.4).

### 19.2 Model and operations
The session model holds **bins** `{id, name, parent}` (the root bin has the fixed ID `root`) and **clips** `{id, name, bin, color, flags, meta, file}`:
- `meta` is the clip's set metadata, one field per key. `flags` is a sorted list of flag colours.
- `file` is the fingerprint `{name, size, hash}` (§10.1): SHA-256 over the size plus the first, middle and last 1 MB.
- Timelines in the pool are not part of M3 (M4).

Operations set values, so applying the same one twice changes nothing:
- `bin.create {id, name, parent}`, `bin.set {id, name?, parent?}`, `bin.delete {id}` (also deletes what's inside, as Resolve does)
- `clip.create {id, name, bin, color, flags, meta, file}`, `clip.set {id, name?, bin?, color?, flags?, meta?}`, `clip.delete {id}`

Collab IDs are random 128-bit hex, chosen by whoever creates the item.

### 19.3 Host-ordered log
- A member **proposes** an operation to the host. The host checks it (known IDs, valid values, a bin can't move into itself), gives it the next sequence number, applies it to the model and **commits** it to everyone, including the proposer. The host's own changes are committed directly.
- Everyone applies commits in sequence order. A gap, or a reconnect, makes the member ask for the host's full state `{seq, model}`.
- A member accepts commits and state only from the host's peer ID, which the host announces when a peer connects. When the host leaves, the member forgets that ID, so a restarted host (new peer ID, same invite code) is accepted. Until M6 anyone with the invite code is trusted.
- M3 doesn't reject stale proposals yet: when two edits of the same field race, the later commit wins on every PC. First-to-host-wins with undo and notice is M7.

### 19.4 Bridge side
- **Scan** every 0.6 s:
  - Walk all bins, and list every clip's unique ID to spot added and removed clips.
  - Fully re-read new clips, plus up to 60 existing clips in rotation. At 300 clips, a metadata change shows within ~3 s; name, bin and colour changes show within one rotation.
  - Changes are emitted as events:
    - `mp.bin {id, name, parent}` and `mp.clip {id, rcId, name, bin, color, flags, meta, path}` for added or changed items;
    - `mp.gone {kind, id}` for removed items.
  - `mp.snapshot` re-emits everything, then `mp.synced {bins, clips}`. The bridge does this on its own when it starts.
- **Companion restart while the bridge runs:** the heartbeat carries `handled`, the last inbox sequence number the bridge has handled. A companion that didn't see `HELLO` attaches to the bridge on its first heartbeat, numbers its commands from `handled + 1` (commands sent earlier wait until then), and asks for `mp.snapshot`.
- **Commands**, each reading the result back and replying with the item's new record:
  - `mp.bin.create {parent, name}`, `mp.bin.rename {id, name}` (emulated, §19.1), `mp.bin.move {id, parent}`, `mp.bin.delete {id}`
  - `mp.clip.import {bin, path, rcId, name, color, flags, meta}`, `mp.clip.link {id, rcId}`, `mp.clip.set {id, …}`, `mp.clip.delete {id}`
  - `project.backup {path}` (exports the open project as `.drp`)
- Items a command touched are refreshed in the bridge's last-seen state, so they aren't reported back as local edits. Events over ~750 bytes are split into `PART` log lines and reassembled by the companion.

### 19.5 Companion side: one reconciler
For every bin, clip and field, the reconciler compares three values:
- **base**: the last value this PC and the session agreed on, saved to disk;
- **local**: Resolve now, translated to collab IDs;
- **session**: the host's model.

| local vs base | session vs base | Live | Catch-up (connect, reconnect, bridge start) |
|---|---|---|---|
| same | same | nothing | nothing |
| changed | same | propose it | propose it |
| same | changed | command the bridge | command the bridge |
| changed | changed, equal | update base | update base |
| changed | changed, different | if this PC has a proposal for that field in flight, wait for it; otherwise the session wins and the terminal says whose value replaced yours | **ask** Keep mine / Keep theirs (§9.3) |

Further rules:
- A deleted item on one side with an edit on the other always asks, in both modes (§9.3: a deletion never wins silently).
- **Catch-up order** (§9.3):
  1. backup `.drp` if anything local will change;
  2. answer every question in the terminal, with "apply to all";
  3. send all proposals together and apply all commands.
- No two commands for the same item are in flight at once.
- A new local clip without an `rcId` gets a fresh collab ID, written into Resolve with `mp.clip.link`, then is proposed as `clip.create`.
- **First join** (no base yet; until M6):
  - Bins match by path. Clips match by fingerprint plus bin path, then fingerprint alone, without reusing a match.
  - Matched items take the session's values. Unmatched local items are proposed, and unmatched session items are created locally.
- **Saved state** in `%USERPROFILE%\ResolveCollab\sessions\<topic>\`: the base, bin ID map and missing list (`host.json` or `member.json`), and on the host its log state (`host-log.json`). Backups go to `%USERPROFILE%\ResolveCollab\backups\`.

### 19.6 Media for incoming clips
For `clip.create` from someone else, the companion looks for a local file with the same fingerprint, in this order:
1. a local clip not yet linked to anything, which is linked and moved into place instead of re-imported;
2. a file of the same name in any folder that holds this PC's other clips;
3. a file of the same name in the user's Downloads, Videos, Desktop or Documents folder.

The creator's path is not tried: it names a folder on another PC, and the same path here may hold a different file (the fingerprint would catch that, but the search above already covers the useful cases). The per-project media folder (§10.4) is added to the search with M9.

If none matches, the clip goes on the **missing list**, printed with a `locate <clip> <path>` command. Download from peers is M9.

### 19.7 Verification
- **Unit tests:** model and operations, host log ordering and gaps, every reconciler row including first join and delete-vs-edit, fingerprints, `PART` reassembly, and the Lua bridge's pure parts under `fuscript`.
- **Pipeline test:** two companions with fake media pool bridges over a local testnet:
  - live edits both ways;
  - an offline edit merged with a dialog answer;
  - a missing file located later;
  - a companion restarting while its bridge keeps running (member, then host).
- **Real Resolve on one PC:** `tools/m3-resolve-check.ts` runs Resolve as host with a fake member, against an empty scratch project. It covers every command, Resolve-side edits made by hand, a backup, and a companion re-attaching to the running bridge.
  - **Result, 2026-11-03, Free 21.1.2: all checks passed.**
  - Member → Resolve: each change read back in 0.2–0.4 s.
  - Resolve → member: within one 0.6 s scan.
  - The final snapshot after re-attaching matched the member's pool.
  - **Re-run after the inbox doorbell (§3.2), same day: all checks passed again, this time on the Media page.** A Scene number typed into the Metadata panel stayed while the bridge ran, and was reported about 1 s later.
- **Two PCs:** the user's checklist in `docs/m3-two-pc-test.md`.
  - **Result, 2026-11-03, Free 21.1.2 on both PCs: passed.**
  - **Live, both ways:** bins, imports, colour, flags, Scene/Take metadata, clip and bin renames, moves, sub-bins and deletes all synced within ~2 s. The file was found on the other PC by fingerprint from Downloads.
  - **Missing media:** two same-name, same-size downloads had different content, so the clip was correctly listed as missing. It was imported with `locate` once the other PC's copy was in place.
  - **Offline merge:** only the name (changed on both) was asked about, only on the returning PC. Colour and Take merged automatically, and a backup `.drp` was saved first.
  - **Host restart with `host --code`:** the member rejoined, and the host continued its log.
  - **Found and fixed during the test:**
    - listing the inbox emptied the Metadata panel and stalled the bridge on the Media page (inbox doorbell, §3.2);
    - `locate` wrongly said "not the same file" for a path it couldn't read;
    - the merge prompt claimed the backup had already been saved.
  - **Not yet built:** the notice to the overwritten person (§9.3, point 7) comes in M7.
