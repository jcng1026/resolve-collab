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
- **Liveness:** the bridge writes a heartbeat key every second. No heartbeat for 15 s means the bridge is not running (§9.4). Resolve stops running scripts while you drag some controls (5–9 s while dragging a fade handle in the two-PC test, 2026-11-04), so a shorter gap is only Resolve being busy.

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
| 1 Direct | The matching API call | Instant | On Free 21.1.2 every timeline edit works directly (§20.1) |
| 2 Rebuild clip | Read every property of the item → delete → re-append with the new in/out/position → restore properties, markers, Fusion comp | ~1 s | Only if every property can be read back |
| 3 Timeline swap | A peer that can apply the edit exports the timeline as `.drt`; this peer imports it and swaps it in, keeping the playhead position | A few seconds | Grouped at most once every 2 s |

No edit is ever blocked because a peer is on Free. Free peers may just receive some edits a little later.

All three tiers are built (decision 2026-11-03), although Free 21.1.2 needs only tier 1. A test switch forces tier 2 or 3 so both stay tested (§20.6). **Tier 3 runs only when forced:** it imports a file made on another PC, which could carry scripts (decision 2026-11-03, §20.6).

---

## 4. Session model

### 4.1 Roles
- **Host:** the person who created the session. They are the referee: they decide the order of all operations and who holds each lock, and they store the session state and chat. **The session belongs to its host.** There is no hand-over to another peer.
- **Members:** all equal editors. The host can also remove members.
- Viewer role: v2, only if needed.

### 4.2 Starting and joining
1. The host opens their Resolve project, starts the bridge, and clicks **Start session** in the companion. They get an **invite code**, which they share however they like (WhatsApp, Discord, …).
2. A joiner enters the code. The **host approves each join request** (shown with the joiner's name).
3. A new joiner receives the project as a `.drp`, imported as a normal project in their library named `<Project> (collab · hosted by <Host>)`, then goes live. *Superseded 2026-11-04 (§22.3): the joiner's companion creates that project empty and sync fills it; no `.drp` is imported.*
4. A joiner who already has a copy of this session's project only receives the changes they missed (§9).

### 4.3 Host connection lost vs host leaving
- **Host connection lost:** members switch to offline mode (§9.1) and retry for up to **10 minutes**. If the host returns, everyone reconnects and merges automatically.
- **Host ends the session, closes the app, or the 10 minutes pass:** the session ends for everyone. Members keep their local copies. Any queued changes are kept locally and flagged as **not synced to the host**.

### 4.4 Resuming another day
- **Only the host** can reopen their session, with the **same invite code**. Members rejoin with that code and catch up (§9). *Superseded 2026-11-04 (§22.1): every opening gets a new invite code; a hidden session ID says which session it is.*
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
- **Bridge not running** (forgot to start it, or Resolve restarted): a large banner says **"Sync paused — start ResolveCollab in Resolve"**, after 15 s without a heartbeat (§3.2), and the companion says when sync resumes. When the bridge starts, it compares the project with the last state it knew, and the merge in §9.3 runs.
- **A different project open in Resolve:** sync pauses with *"You switched to another project — switch back to resume."* Nothing from the other project is ever sent.

### 9.3 Merge rules (same everywhere)
Three versions are compared for each item: the **last version everyone agreed on**, **yours now**, and **the session's now**.
1. A **backup `.drp`** of your project is saved first.
2. Items only you changed are sent to everyone.
3. Items only others changed are applied to your copy.
4. Items you both changed:
   - **Different properties** (you changed volume, Alex trimmed): both are kept automatically.
   - **Same property:** dialog with **Keep mine / Keep Alex's**, one decision per item, plus **Apply to all remaining**. A linked video and audio pair that conflicts the same way is one item.
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
| Edits to a timeline that isn't open | Applied when that PC opens the timeline (2026-11-03) |
| Fades | Synced live; Resolve forgets API-set fades on reopen, so the companion re-applies them when the project opens with the bridge running (2026-11-03) |
| Titles and generators | Text+ fully (text, font, size, place, length). Basic titles and generators placed at the right length; their words/settings can't sync, the companion warns (2026-11-03) |
| Apply tiers | All three built; tier 1 used whenever it works; a test switch forces tiers 2 and 3 (2026-11-03) |
| Tier 3 (timeline swap) | Off in normal use, only with `--force-tier 3`: importing another PC's `.drt` could run scripts hidden in Fusion comps. A change that would need it is reported, to be made by hand (2026-11-03) |
| Markers | Timeline, item and media pool clip markers all sync; each carries its collab ID in its hidden `customData`; markers on a timeline that isn't open arrive when it's opened (2026-11-04, §21) |
| Two markers on one frame | A clash: in catch-up the returning person picks Keep mine / Keep theirs; live, first to the host wins; no "keep both" (2026-11-04, §21.5) |
| Sessions (M6) | Joiners get a fresh project built by syncing, no `.drp` import; a new invite code every time the host opens the session, with a hidden session ID; first join = new project made by the companion, rejoin = last time's project; removal blocks that PC (2026-11-04, §22) |
| Racing edits, undo, notices (M7) | Second change undone only when it hit the same property; the companion claims Ctrl+Z / Ctrl+Shift+Z on the Media, Cut and Edit pages (after a probe); notices with Reapply / Restore mine are terminal lines for now (2026-11-04, §23) |
| Companion window (M8) | Electron; a small always-on-top chat bar at the bottom right that expands into a tall strip with Chat and Changes tabs; urgent items stacked above the bar; Apple-style dark HUD look (2026-11-05, §24) |

---

## 18. M2 design: thin end-to-end

Goal: on two PCs, a clip appended to the current timeline on one appears on the other within 2 s. Everything else waits for later milestones.

### 18.1 Bridge wire format
- **Outbound log line:** `RC|<bridgeId>|<kind>|<hex(JSON)>`, raised through `fusion:Execute('error("…")')`. `bridgeId` is random per bridge start, so lines from older runs are ignored. Kinds:
  - `HELLO` (product, version, Studio flag, inbox, and `handled` = 0: a new run counts inbox messages from its own start)
  - `HB` (heartbeat, every 1 s; carries `handled`, see §19.4)
  - `HELLO` and `HB` also carry `build`: a hash of the bridge file, stamped by `tools/install-bridge.ts`. The companion compares it with the hash of the bridge file in its own checkout. On a mismatch it says to run `install-bridge` and start the bridge again, because a bridge Resolve is still running from before an update doesn't know the newer commands (it answered `unknown-command` in the M5 two-PC test, 2026-11-04).
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

---

## 20. M4 design: timelines

Goal (§16): §6.1 timeline items sync both ways, live and after offline or bridge-off time. Applies the decisions of 2026-11-03 (§17). Markers are M5; undo and first-to-host-wins are M7.

### 20.1 What Resolve allows (probes, `docs/feasibility/findings-2026-11-02.md`, "M4 timeline probe")
- Every edit works directly on Free 21.1.2. **Exceptions and side effects:**
  - **Fades** set through the API are lost on save + reopen (also reported on Studio 21.1.0).
  - **Adding** only works on the current timeline. **Delete and enable** don't work on a timeline that isn't current.
  - `AppendToTimeline` **never overwrites** (the space must be clear) and **moves the playhead**.
  - A **move onto occupied space overwrites** what was there.
  - **Titles and generators** are inserted with ripple at the playhead. They are safe past the end of the timeline, and take their length from the In/Out marks. Basic titles can't be trimmed, and their words can't be read or set. Text+ text, font and size are read and set through its Fusion comp.
  - `DuplicateTimeline` and `.drt` import switch the current timeline. `.drt` import copies the timeline's `rcId`.
- Item and timeline unique IDs persist. Reading costs ~0.5 ms per item for positions and ~1.4 ms for everything.

### 20.2 Model and operations
- **Timeline** `{id, name, fps, width, height}`.
- **Track** `{id, timeline, kind, order, name, enabled, locked, subType}`.
  - Resolve's tracks have no IDs, only positions, so tracks get collab IDs and items point at a track ID. Deleting a middle track then can't be mistaken for deleting another one.
  - `order` is the 1-based position. A track delete moves the tracks above it down, as in Resolve.
  - Resolve's default names ("Video 2") follow the position, so they're stored as no name.
- **Item** `{id, timeline, kind, track, start, duration, enabled, color, name, …}`.
  - `start` counts frames from the timeline start.
  - `kind` is one of:
    - `clip`: also `media` (collab clip ID), `srcStart`, `speed`, `link` (the smallest collab ID of a linked video/audio group), `fadeIn`, `fadeOut`, and for video `props` (the 32 `GetProperties` keys);
    - `textplus`: also `template`, `text {styled, font, style, size}`, `props`, `fadeIn`, `fadeOut`;
    - `title` / `generator`: also `template` (for example `Text`, `Solid Color`);
    - `transition`: also `template` and `edge {item, side, alignment}`, where `side` is `start`, `end` or `cut`.
- **Operations** set values, as in M3: `timeline.create/set/delete`, `track.create/set/delete`, `item.create/set/delete`.
  - Deletes cascade: a timeline takes its tracks and items, a track its items, an item its transitions.
  - A duplicated timeline needs no operation of its own: it arrives as a new timeline with its tracks and items.
- They go through the same host-ordered log (§19.3). The session model is the media pool and the timelines together, and operations are routed by type. A saved M3 log (media pool only) is still accepted.
- Compound clips, multicam, Fusion clips, effects, keyframes and Fairlight settings are not part of M4. An item using them is reported as "not synced" and left alone.

### 20.3 Identity
- **Timelines:** the collab ID is stored as `rcId` in the timeline's media pool item.
  - Two timelines with the same `rcId` (a `.drt` import or a copied project) keep the first. The other gets a new collab ID and is proposed as a new timeline.
  - On first join, a timeline without an `rcId` is matched to a session timeline of the same name.
- **Tracks:** the companion keeps each timeline's track collab IDs by position.
  - When positions change, it works out which track went where from where each track's clips went, then by name, then by order.
  - A timeline seen for the first time maps onto the session's tracks by position.
- **Items:** the companion keeps a map from local unique ID to collab ID (items have no metadata).
  - An unknown local item is matched to a session item of the same kind in the same place (track, start, duration, media). This covers a first join, a tier-3 swap, and Resolve giving an item a new ID.
  - Only items Resolve still has hold their collab IDs, so an ID whose item has gone is free to be matched again.
- **Transitions** are found from where they sit: a clip starting where the transition starts, ending where it ends, or a cut at its middle. Resolve's reported alignment is only a first guess: it read "center" for a transition it had reported as "right" moments before.

### 20.4 Bridge side
- **Scan:**
  - The timeline list, with its project's ID, every 0.3 s.
  - Only the current timeline can be edited by the user, so only its tracks and items are scanned. Positions of every item every scan (~0.5 ms per item); full records for new or moved items and a rotating share of the rest (like §19.4).
  - Switching timelines reports the new one in full: `tl.reset`, tracks, items, `tl.synced`.
  - **The user's changes are reported once they have been still for 1 s.** While the user drags a clip, Resolve shows it to scripts as an item. Editing around it crashed Resolve in the two-PC test (2026-11-03). Changed, new and gone items and track changes are held back until nothing has changed for 1 s. Changes made by the bridge's own commands (to the items they touch and the items linked to them) are reported the same way but don't count as the user editing. A drag held still for longer is caught by the companion's mouse check (§20.5).
  - **Items Resolve can't fully read yet count as still moving.** While a title, clip or transition is being dropped, Resolve briefly reports items with no position or length, and clips with no transform properties (two-PC test, 2026-11-04). The scan used to fail on them, and once passed on three items without their zoom. Such items are read again later and reported only once they read fully; meanwhile they hold the 1 s wait, for at most 3 s per item, so an item that never reads fully can't block sync. A scan that meets an item whose ID can't be read doesn't decide what was deleted.
  - **Both the media pool scan and the timeline scan hold their findings back**, and drop them if the project changed during the scan. Resolve keeps the bridge running while it loads another project; once, a pool walk read the other project, and its bins were reported as new and this project's clips as deleted.
- **Commands**, each reading the result back:
  - Commands that edit the open timeline answer `user-editing` while the user's own changes are less than 1 s old, and change nothing.
  - A command whose item can't be read back fully answers `unreadable`; an add removes its item again first.
  - `tl.create/link/set/delete/export/swap`. A created timeline becomes current in Resolve, so the bridge puts the user's timeline back.
  - `track.add/set/delete`. Each returns the new track list, since the bridge doesn't report its own changes as events.
  - `item.add`:
    - nothing (other than a transition) is ever added onto occupied space: the answer is `occupied`;
    - clips: `AppendToTimeline` with `recordFrame`, `trackIndex`, `startFrame`/`endFrame` and `mediaType`. **`startFrame`/`endFrame` count the clip's own frames**, while item offsets and lengths count the timeline's, so they're converted by the clip's FPS over the timeline's; a frame lost to rounding is trimmed back;
    - an add that reads back wrong is deleted again and answers `readback`, so retries can't pile up copies;
    - titles and generators: save the user's In/Out marks, mark the length past the end of the timeline, insert, restore the marks, then move into place;
    - Text+: also sets its Fusion inputs;
    - transitions: `AddTransition` on the edge item, trying the categories in turn.
  - `item.set` (source start, length, position and track, properties, speed, fades, enabled, colour, name, text). Trims are in timeline frames, whatever the clip's speed. A basic title or generator can't be trimmed, so a length change answers `cannot-trim` and is rebuilt (tier 2).
  - `item.delete`, `item.link`.
- **The playhead is put back** after every append and insert.
- `HELLO` carries `handled` (0): a bridge started again counts inbox messages from its own start, and the companion follows (§18.1).

### 20.5 Companion side
- **The same reconciler as §19.5**, for the timeline domain. It compares the timeline list and **the open timeline only**.
- **Timelines that aren't open:** their changes stay in the session. When one is opened, it's compared as a catch-up, which applies them. No queue is needed. Timeline-level changes (create, rename, delete) apply at once. The companion says "changes to <timeline> will be applied when you open it".
- **Another project open:** timeline lists from a project other than the session's are never compared (§9.2).
- **Order within a batch:** timeline and track creates, item deletes, item sets, item creates, transitions, track sets and deletes, then timeline sets and deletes. Items moving right go rightmost first and items moving left leftmost first, so a ripple never lands on a neighbour (a move onto occupied space overwrites in Resolve).
- **Fields one side doesn't report** (transform properties of audio clips in Resolve) are neither proposed nor applied.
- **An already synced item that can't be identified for a moment** is skipped, not taken as deleted.
- **Fades are volatile:**
  - in catch-up after the project opens, a local fade of 0 where the base has a fade is treated as "Resolve forgot it" and re-applied, not proposed;
  - removing a fade while the bridge is running syncs normally;
  - removing one while the bridge is off is undone at the next start;
  - a PC that opens or renders the project without the bridge has no API-set fades.
- **Media:** a clip whose media pool clip isn't linked yet is retried every second; one whose file is missing waits on the missing list (§19.6).
- **Nothing is compared or sent to Resolve while the left mouse button is held** (anywhere), then for 1 s after the bridge last saw a change (§20.4). A clip being dragged onto the timeline is already a real item to scripts, with the ID it keeps after the drop, and it has already overwritten what lies under it; nothing in the API tells it apart. Resolve's Lua has no `ffi`, so the companion reads that one button's state through a small PowerShell process (`GetAsyncKeyState`). Where that can't run, it says so and relies on the 1 s wait.
- **Warnings**, each shown once per item: basic title words not synced; generator settings not synced; items of unsupported kinds not synced. A transition with no clip at its edge (its clip was just deleted, and Resolve removes the transition a moment later) is skipped without a warning.
- **Timeline delete:**
  - when the bridge sees a local timeline deletion, the companion asks the deleter in the terminal: "Delete '<name>' for everyone?";
  - if they decline, nothing is sent and the timeline is rebuilt from the session on their PC;
  - receivers save a backup `.drp` before applying a remote timeline delete.

### 20.6 Apply tiers (§3.5)
- **Tier 1 (direct)** is always tried first. A command that fails or reads back wrong moves to tier 2, without a message (a transition's length, for one, can only be changed this way); the terminal only hears about it if tier 2 fails too. A change of media or of a transition's edge goes straight to tier 2.
- **Tier 2 (rebuild):** delete the item, add it again with every value from the session (by `item.add` rules), and map the new local ID to the same collab ID. If that fails, go to tier 3.
- **`not-current`, `user-editing` and `unreadable` only mean "not now":** no rebuild, no warning; the change is tried again a second later.
- **A failed add is tried once per session value.** It's tried again only when someone changes that item, so a failing add or rebuild can't loop. An item a failed rebuild removed counts as still to add, never as deleted on this PC.
- **Tier 3 (timeline swap):**
  1. this PC asks the peer that last changed the timeline (who has it open and up to date) for a `.drt` export of it, sent in chunks over the peer link (at most 200 chunks of 256 KB);
  2. the bridge imports it, deletes the old timeline, gives the copy its name and `rcId`, and keeps the user's current timeline and playhead;
  3. the companion maps the new items by position (§20.3), and fades come back as in §20.5.
  - Also used when a track was inserted between others, which Resolve can't do by script.
  - Not built: grouping swaps to at most once every 2 s.
  - **Security: tier 3 runs only with `--force-tier 3` (decision 2026-11-03).** This is the one path where a file made on another PC would be imported into Resolve. A `.drt` can hold Fusion compositions (every Text+ title is one), and Fusion comps can carry scripts that Resolve runs. So a tampered `.drt` could make this PC run code, against §13's rule that peers send data, never code. In normal use, a change that would need tier 3 is reported instead ("this change can't be synced here, so make it by hand on this PC"). Today that's only a track inserted between others.
- **Test switch:** `--force-tier 2|3` makes every eligible change use that tier.

### 20.7 Confirmed before building (probe, 2026-11-03)
- **In/Out marks set the length** of an inserted Text+, basic Text title and Solid Color generator, including longer than the 120-frame default (300 frames tested).
- **Transitions:** `SetProperty("TransitionDuration")` changes the duration, and `DeleteClips` deletes a transition. **`TransitionAlignment` can't be changed**, so an alignment change is applied as delete + add.
- **`CreateEmptyTimeline` makes the new timeline current**, so the bridge switches back afterwards. `SetSettings` on a new timeline sets fps and resolution.
- The user's In/Out marks can be read and restored exactly.
- `DeleteTrack` on a track with items deletes the items too.

### 20.8 Verification
- **Unit tests:** model and operations, cascades and track shifts, the reconciler per field (volatile fades, ripple order, delete coverage, catch-up questions), identification (middle track delete, first join, duplicate `rcId`, links, transition edges, items with new IDs), the Lua bridge's timecode and item-kind helpers.
- **Pipeline test:** two companions with fake bridges over a local testnet:
  - join with linked audio;
  - live edits both ways;
  - a new track and a Text+ title with its words;
  - a timeline that isn't open;
  - a fade Resolve forgot;
  - a middle track delete;
  - a project switch that reports the timeline list before the media pool;
  - forced tiers 2 and 3;
  - without forcing, a track inserted between others is reported and no timeline file is exported or imported.
  - The fake reports timeline lists at the real bridge's pace, so races between a command's result and the next list are caught.
- **Real Resolve on one PC:** `tools/m4-resolve-check.ts` runs Resolve as host with a fake member.
  - **Result, 2026-11-03, Free 21.1.2: all checks passed** (project "RC M4 Check 6"). That covers:
    - every command;
    - edits made by hand in Resolve (clip colour, a delete);
    - a timeline that wasn't open, applied when opened;
    - a project switch taken as a pause only;
    - a fade put back after reopening;
    - the bridge's export and swap;
    - a final comparison.
  - With `--force-tier 2` (automatic steps): all checks passed.
  - **Rerun after the two-PC crash fix, 2026-11-03** (projects "RC M4 Check 8" to "12"): all checks passed, at tier 1 and forced tier 2. New steps:
    - 7b: a 30 fps clip on the 24 fps timeline, added from frame 24 and trimmed;
    - 7c (`--drag`, and in the full run): a clip held mid-drag over the timeline for 5 s while the member keeps moving and recolouring another clip. Resolve didn't crash, nothing was applied while the button was held, and both sides matched afterwards.
  - **Rerun after the second two-PC test's fixes, 2026-11-04** ("RC M4 Check 13" with `--auto --drag`, "14" with `--auto --force-tier 2`): all checks passed, with no bridge errors.
  - Bugs it found, all fixed:
    - a scan read the other project during a switch (M3 media pool bug: this project's clips were deleted);
    - a project switch looked like deleting every timeline;
    - a restarted bridge ignored the companion's commands;
    - a just-created timeline looked deleted before Resolve's next list;
    - the unreliable transition alignment;
    - audio clips' missing properties.
  - Not covered here: a tier-3 swap between two real Resolves (the check exports and swaps on one PC); an offline merge of timeline edits (unit-tested; in the two-PC checklist).
- **Two PCs:** the user's checklist in `docs/m4-two-pc-test.md`.
  - First run, 2026-11-03: PC 1's Resolve crashed while a clip was held mid-drag (fixed in §20.4/§20.5).
  - **Second run, 2026-11-04, Free 21.1.2 on both PCs: every step passed** after the fixes in `docs/feasibility/findings-2026-11-02.md` ("second M4 two-PC test"): live edits both ways including zoom, a held drag, Text+ and basic titles, a dissolve, deletes and disable, a fade and its return after reopening, a timeline that wasn't open, an offline merge with one length question, and deleting a timeline for everyone. Undo on PC 1 also synced, taking back PC 2's change too (a known limit until M7, §7).
- **Free ↔ Studio** can only be checked by a user with genuine Studio. Until then it is untested.

---

## 21. M5 design: markers

Goal (§16): §6.1 markers sync both ways, live and after offline or bridge-off time. Decisions of 2026-11-04 (asked before building): **all three kinds** of marker sync; each marker carries its **collab ID in its hidden `customData`**; markers on a timeline that isn't open arrive **when it's opened**, like its items (§20.5).

### 21.1 What Resolve allows (probe, `docs/feasibility/findings-2026-11-02.md`, "M5 marker probe")
- Three kinds, each with the same calls: **timeline markers** (on the ruler), **item markers** (on a clip in a timeline) and **clip markers** (on a media pool clip, set in the source viewer).
- **No call changes a marker.** Colour, name, note, duration and frame change by deleting it and adding it again.
- **One marker per frame per owner.** Timeline markers count frames from the timeline's start; item and clip markers count frames in the source media, so they stay put when an item is moved or trimmed.
- `customData` is hidden from users, can be set on an existing marker, and survives renaming, recolouring and dragging in Resolve's interface and save + reopen.
- **Copies:** adding a clip to a timeline copies the pool clip's markers onto the new item and its linked audio, and `DuplicateTimeline` copies timeline and item markers, both with their `customData`.
- **Copies can land between frames** (second probe, 2026-11-04, after the two-PC test found one): on an item whose frame rate differs from the timeline's, a pool marker's copy keeps its exact time (frame 7 of a 30 fps clip lands at 5.6 on a 24 fps timeline; its length 3 becomes 2). `GetMarkers` lists it at the frame below, where `GetMarkerCustomData`, `UpdateMarkerCustomData` and `DeleteMarkerAtFrame` don't find it, nor do the exact frame or `DeleteMarkerByCustomData`. `DeleteMarkersByColor("All")` does clear it, and markers added back on the listed frames work normally.
- Markers on a timeline that isn't current can be read and written, but its items aren't scanned (§20.4), so the open-timeline rule stays.
- Reading is cheap: 0.74 ms per 100 timeline markers, under 0.1 ms per item or clip.

### 21.2 Model and operations
- **Timeline and item markers** live in the timelines model: `markers: {id → {id, timeline, item, frame, duration, color, name, note}}`. `item` is `""` for a timeline marker, else the item's collab ID. `frame` is the timeline frame for a timeline marker and the source frame for an item marker.
- **Clip markers** live in the media pool model: `markers: {id → {id, clip, frame, duration, color, name, note}}`.
- **Operations:** `marker.create/set/delete` (timelines) and `poolmarker.create/set/delete` (media pool), through the same host-ordered log (§19.3). Session models saved before M5 are accepted (no markers).
- **Deletes cascade:** a timeline or item takes its markers, a pool clip its clip markers.
- **Checks:** colour is one of Resolve's 16 marker colours; frames are 0 to 100,000,000 and durations 1 or more; names up to 255 characters and notes up to 10,000; up to 5,000 markers per owner.
- **One marker per frame per owner**, as in Resolve: the host refuses a `create` or `set` that would put a marker on a frame where the same owner already has another (`occupied`). Whole models from a peer or from disk aren't checked for this (sessions saved before 2026-11-04 may hold two).

### 21.3 Identity
- `customData` holds `rc:<collab ID>` for timeline and item markers, and `rc:p:<collab ID>` for clip markers: adding a clip to a timeline copies the pool clip's markers onto the item, and those copies must not pass for the pool clip's own markers.
- **A local marker is matched:**
  1. by its `rc:` ID, if the session doesn't have that ID on another owner (a copy made by `DuplicateTimeline` or by adding a clip to a timeline keeps the original's ID, and is a new marker);
  2. else to a session marker on the same owner at the same frame with the same colour, name, note and duration (first join, and copies another PC made);
  3. else it's new and gets a new collab ID.
- **Tagging:** a marker whose `customData` isn't its `rc:` ID is given it (`UpdateMarkerCustomData`). `customData` that another tool wrote (not empty, not `rc:`) is never overwritten: such a marker is matched by owner and frame instead.
- Markers of an item the companion adds (or rebuilds, §20.6) start empty: Resolve's copies of the pool clip's markers are removed, and the session's markers for that item are added. Copies made when the user adds a clip are the user's edit and sync as new markers.

### 21.4 Bridge side
- **Scan:**
  - Timeline markers of the current timeline every scan, one `tl.marker` record per marker and `tl.marker.gone` by frame;
  - item markers as part of each item's record;
  - clip markers as part of each media pool clip's record.
  - Marker changes count as the user editing (§20.4): they're held until the timeline has been still for 1 s.
- **Commands**, each read back:
  - `marker.add` `{owner, frame, duration, color, name, note, tag}`;
  - `marker.set` `{owner, at, frame, duration, color, name, note, tag}`: deletes the marker at `at` and adds the new values; if they can't be placed, the old marker is put back;
  - `marker.delete` `{owner, frame}`;
  - `marker.tag` `{owner, frame, tag}`.
  - `owner` is `{kind: "timeline" | "item" | "clip", id}` with the local unique ID. Timeline and item markers need their timeline to be current (`not-current` otherwise); clip markers don't.
  - A marker that reads back wrong is removed again (`readback`); one on an occupied frame answers `occupied`.
  - **Snapping:** when `marker.tag`, `marker.set` or `marker.delete` meets a marker the per-frame calls can't reach (§21.1, between frames), the bridge first puts all of that owner's markers on their listed frames: delete all, add each back with every value and tag, read back. It moves a copy by less than a frame. An owner that fails to snap answers `snap-failed`, then `unreachable`, and isn't tried again in that run. The companion tags copies on first sight, so they're snapped as soon as they appear.
  - `marker.set` never adds the new values while the old marker is still there (`unreachable`), so it can't make two.
  - Commands on item markers answer the item's record, on clip markers the clip's; on timeline markers the changed markers' records and `markerGone` (frames left empty).
  - `item.add` removes the new clip's markers before answering (§21.3).

### 21.5 Companion side
- **The same reconciler**, with markers as another kind in each domain. Within a batch, markers come after the items and clips they belong to are created, and before those are deleted.
- **Timeline and item markers** follow the open-timeline rule (§20.5). **Clip markers** sync whenever the media pool does.
- **Two markers on one frame** (decided 2026-11-04, the §9.3 rules applied to a frame): when this PC would add or move a marker onto a frame where the session has another marker on the same owner, it's a clash on that frame, because Resolve holds only one.
  - **Catch-up:** the returning person is asked, like any same-field conflict: *keep mine* replaces the other marker with theirs for everyone; *keep theirs* removes theirs (or moves it back) and brings the other marker in. The notice to the person whose marker was replaced (with Restore mine) comes with M7, as for every conflict.
  - **Live:** first to reach the host wins (§5). The other PC's marker is removed (or moved back), the winner's comes in, and it's told its marker was replaced. A clash the host itself refuses (`occupied`, both sent at the same moment) is resolved the same way on the next pass.
  - A linked video and audio pair that clashes the same way is one question.
  - Keeping both (moving one to the next free frame) was offered and turned down.
- **A marker that couldn't be placed** (Resolve refused it) is said once and not tried again until someone changes it.
- **A rebuilt item's markers** (§20.6) are still to add, not deleted on this PC.

### 21.6 Verification
- **Unit tests:** marker ops and their checks, cascades, the reconciler with markers (a moved marker is one change, not a delete and an add), identification (`rc:` IDs, copies keeping another owner's ID, matching by place, foreign `customData`).
- **Pipeline test** (fake bridges): timeline, item and clip markers both ways; a moved and a recoloured marker; markers on a timeline that isn't open; a duplicated timeline; markers copied when a clip is added, by the user and by the companion; an offline merge of marker edits; two markers on one frame; a rebuilt item's markers. The fake also now reports the timeline list again on a full report, as the real bridge does (a companion restarting with the bridge running never saw it before).
- **Real Resolve on one PC:** `tools/m5-resolve-check.ts`.
  - **Result, 2026-11-04, Free 21.1.2: all checks passed** in "RC M5 Check 1" (`--auto`), "2" (`--auto --force-tier 2`) and "3" (every step). That covers timeline, item and pool clip markers sent to Resolve (all values, a 3,000-character note with emoji, a marker past the end), tags, a move and recolour keeping the tag, deletes, the pool marker's copy on a clip the companion added, a rebuilt item's marker, and by hand in Resolve: a marker added with M, dragged and recoloured, and one removed in its dialog.
- **Two PCs:** the checklist in `docs/m5-two-pc-test.md`.
  - **Run 2026-11-03/04, Free 21.1.2 on both PCs: every step passed** after three fixes it led to: pool marker copies between frames are snapped (§21.4); two markers on one frame are a clash, asked or won by the host (§21.5); a companion shutting down no longer counts its last command as refused. Checked on both PCs from their bridge logs (PC 2 through a Claude session over Remote Control): ruler, clip and pool markers both ways with the same hidden IDs; a move and recolour as the same marker; a clip added again with one copy; a timeline that wasn't open; a duplicated timeline (opened before the original in a new session, so the copy kept the old IDs: a known limit); an offline merge of a name and a colour without a question; two different markers on one frame, asked once, with "keep mine" leaving the returning PC's marker on both.

---

## 22. M6 design: sessions

Goal (§16): §4 complete. Decisions of 2026-11-04 (asked before building): a joiner's project is **built by syncing**, not imported from a `.drp`; **every opening of a session gets a new invite code**; a **first join always gets a fresh project**, made by the companion; rejoining uses the project from last time; a removed member's **PC is blocked**. These replace parts of §4.2 and §4.4, as noted below.

### 22.1 Identity
- **Each PC has a lasting key pair**, made on first run and kept in `%USERPROFILE%\ResolveCollab\identity.json` (with the person's name). The companion asks for the name once. Hyperswarm uses the key pair, so a PC's public key is its identity on the peer link. The short ID in the terminal is its first 8 hex digits.
- **Each session has a session ID** (32 hex digits), made by the host's companion when the session is created and **never shared in the invite code**. The host tells it to a member only after letting them in.
- **The invite code only lets you in.** Every time the host opens the session (`host` or `host --resume`), there's a new invite code (as today, random). Yesterday's code finds nobody. This replaces §4.4's "same invite code".
  - An old code can still lead to the host for a while (the code's announcement lingers on the DHT for minutes, and the host's key is lasting), so **the join request carries the code it was made with**, and the host refuses any join whose code isn't the current one, without asking: the joiner is told the code is from an earlier opening, and stops (found in the M6 two-PC test, 2026-11-04).
- **Stores are kept per session ID** (today: per invite code): `sessions/<session ID>/` on every PC. Sessions saved before M6 (keyed by invite code) are still read: their folder becomes the session ID.

### 22.2 Starting and resuming (host)
- `host`: a new session from the project open in Resolve. The companion remembers which local project belongs to which session (`sessions/<id>/session.json`: project ID, name, host key, members).
- `host --resume`: reopens the session that the open project belongs to, with a new invite code. If the open project belongs to none, or to an ended one, it says so and starts nothing.
- **Ending permanently:** typing `end` in the host's companion ends the session for good. Members are told, the session is marked ended on every PC, and `--resume` refuses it. (Chat history, deleted at that point, comes in M8.)

### 22.3 Joining
1. `join <code>`: the companion finds the host on the code's topic and sends a **join request** with the person's name and the code. A request with an older code is refused (§22.1).
2. **The host is asked** in the terminal: `Jo (a1b2c3d4) wants to join: y = let in, n = not now, b = block`. Until then the joiner is told it's waiting, and the host sends it nothing about the session. A PC the host already let in for this session is let in without asking; a blocked one is refused without asking.
3. **Once let in**, the joiner learns the session ID and the host's key, and remembers both (`sessions/<id>/session.json`). From then on it accepts session data only from that host key (today: whoever answers first), so a stranger with a leaked code can't pose as the host to a member who has joined before.
4. **First join** (the joiner's PC has never been in this session): the companion has Resolve **create and open a new project**, named `<host's project> (collab · hosted by <host>)` (with a number if that name is taken), and sync fills it as a first join. The project that was open is left exactly as it was. This replaces §4.2's `.drp` import: nothing made on another PC is imported into Resolve, and only what v1 syncs arrives (§6.1). It also replaces "match and combine" on first join (§17).
5. **Rejoin** (the PC has been in this session before): if this session's project is open, it catches up and merges as today (§9.3). If another project is open, it says which one to open and waits; it never switches project by itself.
- A PC whose records were lost (for example a reinstalled Windows) counts as a first join: it gets a fresh project, and its old one is left alone.

### 22.4 Leaving and dropping out
- **The host closes the companion** (Ctrl+C): before going, it tells members the session is closed. Members say so, stop, and exit; changes made afterwards stay on their PC and are merged at the next rejoin (§9.3). This is "ended" in §4.3; the host can still resume it another day (§22.2).
- **The host's connection drops** (no goodbye): members go offline (§9.1) and keep trying for **10 minutes**. If the host comes back in that time, they reconnect and merge on their own. After 10 minutes they say the session ended, and exit. A host whose companion crashed and was started again (`--resume`) has a new code, so members rejoin with it.
- **A member leaves** (Ctrl+C): the host and others are told.

### 22.5 Removing a member
- Typing `members` in the host's companion lists who's in (name, short ID, online or not). `remove <name or short ID>` disconnects that PC, tells it it was removed, and **blocks its key** for this session: it's refused from then on, whatever code it uses. Everyone else keeps going with the same code.
- The removed PC's project and media stay on it (§4.5). Its companion marks the session ended there.
- `unblock <name or short ID>` lets a blocked PC ask again. The host is asked as for a new joiner; once let in, the PC goes back into **its project from before** and catches up and merges as a rejoin (§22.3.5), including anything changed there after it was removed (decision 2026-11-04, found in the two-PC test: it used to refuse by itself).

### 22.6 Verification
- **Unit tests:** identity file, session records, the join handshake (pending, let in, refused, blocked, known PC), host key pinning, store paths for old sessions.
- **Pipeline test** (fake bridges, local testnet): first join creates a project and fills it; a second PC waits until let in; refuse and block; a known PC rejoins with a new code without asking; host closing ends the session for members; a dropped host within the grace time, and after it; `end`; `remove`; a stranger answering on the topic is ignored by a member who joined before.
- **Real Resolve on one PC:** the bridge's project creation and naming (`tools/m6-resolve-check.ts`, Resolve as the joining member, a fake host).
  - **Result, 2026-11-04, Free 21.1.2: all checks passed.** A first join made and opened "RC M6 Host (collab · hosted by Fake host)" and sync filled it (clip and timeline); the host was asked once; the host closing ended the session for Resolve's companion; the host resumed with a new code and Resolve's PC rejoined without being asked, in the same project, and edits synced again.
  - Found while building, fixed: a restarted companion's messages were dropped as duplicates once PCs kept their key (messages are now numbered per run); the host could let someone in before it knew its project (so the joiner's project was named "Project (collab …)"); the fake bridge compared one project's media pool with another's across a switch, and the host proposed deleting its clips (the real bridge already guards against this, §20.4).
- **Two PCs:** a checklist like the earlier ones (`docs/m6-two-pc-test.md`).
  - **Result, 2026-11-04, Free 21.1.2 on both PCs: passed in full** (after the fixes below). First joins made and filled "Test0/Test1 (collab · hosted by PC 1)" and left the open project alone; edits synced both ways; the host closing ended the session for PC 2, `host --resume` gave a new code and PC 2 rejoined its project without the host being asked, bringing a change made while closed; a minute offline on the host, then PC 2 reconnected by itself; remove, refuse, unblock, let back in; `end`, and `--resume` refusing it.
  - Found and fixed: the first-run name question wasn't printed (the companion looked blank); **an old invite code still reached the resumed host** (its DHT announcement lingers and the host's key is lasting): join requests now carry the code and the host refuses older ones (§22.1); the companion crashed when a join was refused while it was still starting; a removed PC that was unblocked and let in refused the welcome by itself, and now rejoins its project from before (§22.5).
  - Tidied after the test: no backups of a project made for a first join until this PC changes something of its own (they protected nothing; there were three per join); "you are / looking for the host" is printed before the host can answer, and a rejoin no longer also says "joined".

---

## 23. M7 design: racing edits, undo, notices

Goal (§16): §5, §7 and §9.3 point 7 complete, proven by simulator tests with 5 PCs. Decisions of 2026-11-04 (asked before building): a change is undone only when someone else changed the **same property** at the same moment; the companion **takes over Ctrl+Z** on the Media, Cut and Edit pages; notices are **lines in the terminal** for now, with numbered commands (buttons in M8's window).

### 23.1 Racing edits: first to the host wins (§5)
- **Every proposal says what it was based on:** `base` = the sequence number of the newest commit this PC's Resolve had applied when the change was seen. The host's own changes carry one too: the host's Resolve can lag behind its own log.
- **The host remembers, for every property of every object**, the sequence number and author of the commit that last changed it (a property = one field: a clip's colour, an item's start, a marker's frame and so on; creating an object counts for all its properties).
- **A proposal loses a property** when that property was changed by **someone else** in a commit newer than the proposal's `base`: they reached the host first. Properties of the same proposal that didn't race are still committed. The host tells the loser which properties lost, and who won.
- **A delete races** with any change by someone else to that object (or to what it holds: a timeline's items and markers) newer than its `base`: the delete is refused and the object stays for everyone. The person who deleted it is asked, as for any delete against a change (§9.3): keep it deleted (sent again, now after the change, so it goes through) or bring it back. A deletion never wins silently. A change to an object someone else deleted is refused as today (unknown ID).
- Changes by the **same person** never race with each other (quick edits in a row).
- **On the loser's PC** Resolve shows the winner's value (the winner's commit arrives as usual, and the refused property is put back to the session's value), and the terminal says, once per user action:
  `[3] Alex changed the colour of "Interview_03" at the same moment, so your change was undone.  reapply 3 = send yours again`
  `reapply <n>` proposes the loser's values again as a new edit (new `base`), so it wins unless it races again. A linked video and audio pair is one notice.
- This replaces the M3 behaviour ("the later commit wins", §19.3) and is the "lock" of §5: a change is protected from the moment it reaches the host, and nothing blocks editing.

### 23.2 Undo and redo of your own changes (§7)
- **Each PC keeps its own history** of the changes it made that the host committed, newest first, the **last 100 steps**, in `sessions/<id>/undo.json`, so it survives reconnects and restarts of the companion. One **step** is one user action: everything this PC proposed from one detected change (a drag that moves a linked video and audio pair is one step); a catch-up merge (§9.3) is one step.
- **Each entry holds the inverse:** for a change, the property values before it; for a create, a delete; for a delete, everything it removed (the object and, for timelines, tracks and clips, what was cascaded with it), so it can be created again with the same IDs. Undoing a media pool clip's delete brings it back like an incoming clip (§19.6: found by fingerprint, or listed as missing).
- **Undo** proposes the inverse as a normal new edit (first-to-host, §23.1) and moves the step to the redo list; **redo** proposes the step again. A new change of yours clears the redo list.
- **If someone else has since changed** anything the undo would put back, it asks first: `Alex has since changed the colour of "Interview_03". Undo anyway?  y = yes, n = no`. If the object was deleted by someone else, it says so and skips that part.
- **Keys:** while Resolve is the window in front **and** its page is Media, Cut or Edit, the companion **claims Ctrl+Z (undo) and Ctrl+Shift+Z (redo)** with Windows' hotkey registration (`RegisterHotKey`), so Resolve doesn't receive them. It doesn't read any other keys. It releases them when another window comes to the front or Resolve is on another page (Fusion, Color, Fairlight, Deliver keep Resolve's own undo, since those pages aren't synced). The bridge reports the page in its heartbeat (`GetCurrentPage`, works on Free: F8). The terminal commands `undo` and `redo` do the same.
- **Probe first** (§23.4): that Windows lets the companion claim Ctrl+Z while Resolve is in front, that Resolve then doesn't undo, and that releasing gives it back. If it can't, I come back with the "separate shortcut" option (Ctrl+Alt+Z) instead of building it.
- **Known limits:** Resolve's **Edit ▸ Undo** menu still uses Resolve's own undo, which can take back other people's changes; what it changes syncs as your edit (as today). Ctrl+Z while typing in a Resolve text box (a clip name, say) goes to the companion too, as long as the page is Media, Cut or Edit.

### 23.3 "Restore mine" after Keep mine (§9.3 point 7)
- When a returning person's **Keep mine** replaces a property that someone else set last, the host adds to that commit who was replaced and their value. Only the person whose value was replaced (the latest author, §9.3 point 6) is told:
  `[4] Sam's offline changes replaced your colour on "Interview_03" (Timeline 1).  restore 4 = put yours back`
- `restore <n>` is a normal new edit (first-to-host), so answers can't loop. Notices are kept until the companion closes.

### 23.4 Verification
- **Probe on genuine Free 21.1** (`tools/feasibility/`): claim Ctrl+Z / Ctrl+Shift+Z while Resolve is in front; check Resolve doesn't undo, the companion sees the keys, and Resolve's own undo works again after releasing; check the page in the heartbeat.
  - **Result, 2026-11-04, Free 21.1.2: works** (`tools/feasibility/undo-keys-probe.ts`, findings "M7 undo keys probe"): claimed within 30 ms of Resolve coming to the front, Resolve didn't undo or redo, the keys were given back when another window came to the front and when no longer allowed. Claiming them whenever Resolve runs (asked by the user) was dropped: a hotkey is claimed for all of Windows, so every other program would lose Ctrl+Z.
- **Unit tests:** the host's race rule (same property, other property, same author, delete vs change, cascades); inverse operations for every operation type; history steps, its limit of 100 and saving; asking before undoing over someone's change; Restore mine notices.
- **Simulator test with 5 PCs** (fake bridges, local testnet, with delays, reordering and a cut): random edits at the same moments on all five; every PC ends with the same model, every race has exactly one winner and the losers are told; undo and redo on several PCs at once.
- **Real Resolve on one PC:** a race between Resolve and a fake PC, the notice and `reapply`; Ctrl+Z and Ctrl+Shift+Z on the Edit page undoing and redoing only Resolve's own changes; the Color page keeping Resolve's undo.
  - **Result, 2026-11-05: passes**, with seeds varied (`RC_SEED`). It found three bugs, fixed: a PC's own commit that came inside a full state (after a gap or reconnect) left its proposal in flight, so Resolve kept a stale value; an unanswered proposal expired without anything comparing again; commits that came while a first join was still making the project were dropped (the member now asks for the state again).
- **Real Resolve result, 2026-11-05, Free 21.1.2 (`tools/m7-resolve-check.ts`): all checks passed.** A race on a clip's colour (Resolve's change based on an older state) was undone with the notice naming the host; `reapply`; undo and redo, and the question when the host had changed it since; Ctrl+Z and Ctrl+Shift+Z on the Edit page undoing and redoing only Resolve's change; the Color page giving the keys back and keeping Resolve's own Ctrl+Z.
  - Found and fixed: in Resolve a media pool clip's colour also colours its timeline clips, so a recolour (anyone's, or an undo) made the timeline sync propose item colours as this PC's own step, which cleared redo and could undo someone else's colour. An item recolour that follows its clip isn't a step, and a committed change that leaves everything as it was isn't either. The tests' network delay now keeps messages in order, as a real connection does.
- **Two PCs:** a checklist like the earlier ones (`docs/m7-two-pc-test.md`).
  - **Result, 2026-11-05, Free 21.1.2 on both PCs: passed in full** (after PC 2 was brought up to date: its first run was still on M6). Found and fixed: two catch-up questions asked at the same moment shared the terminal's one answer line, so one never got its answer and the media pool sync waited for ever; questions now queue.

---

## 24. M8 design: the companion window, presence and chat

Goal (§16): §8, §11 and §12.1. Decisions of 2026-11-05 (asked before building, in a design grilling): built with **Electron**; ghost cursors come **last** in M8, after an overlay probe; **Follow keeps following** until Stop (or you edit); the **terminal commands stay**. The window replaces the terminal for everyday use. The design is **mocked up and approved before it's built** (a private clickable canvas); the approved mockup's HTML and CSS become the window's.

### 24.1 Two sizes, one window
- **The bar (minimized):** a small horizontal rectangle, about 360 × 150, **always on top of every window**, starting at the bottom right of the screen (offset so it doesn't cover Resolve's Project Manager and Project Settings buttons), draggable, and remembered where you left it, on the monitor you put it on. It shows the **last 3 chat messages** (one line each) and a **reply box** (Enter sends), and an up chevron. It has no close button. With no messages: "No messages yet · say hi below".
- **The strip (expanded):** the chevron (or Esc to go back) grows it into a narrow tall strip, the same width and about 80% of the screen tall, also always on top. It opens **away from the nearer top or bottom edge**, and the chevron points the way it will go (up, or down when the bar sits in the upper half).
- **Closing:** an × at the strip's top right asks **Minimize or Close**, with **Remember my choice** (changeable in Settings). Minimize goes back to the bar. Close quits the companion; for the host that closes the session for everyone (as Ctrl+C does, §22.4), so the host is always warned first, remembered choice or not.
- Apple keeps panels out of sight while their app isn't in front (`panels.md`); here the bar stays on top of everything, by the user's choice, because chat should be readable while doing something else.

### 24.2 Urgent items
- Shown as **cards stacked above the bar**, newest on top, 3 visible then "+N more" (all of them in the strip): a join request (host), a lost race (Reapply, §23.1), a Restore mine (§23.3), changes to review on coming back (opens the strip's Review), and anything that stops sync: Resolve or the bridge not answering, another project open, the host unreachable. Problems clear themselves once fixed; smaller notes (a bridge out of date) go in the strip's status line.
- They **pulse 3 times** on arrival, then stay steady orange, and pulse again every 30 s while waiting. Never more than 3 flashes a second; with reduced motion they don't pulse. A sound is off by default, with a Settings switch (urgent items only; never chat).

### 24.3 The strip
- **Header:** the project, your role, and the people as coloured initials (hover: where they are, §8; click: Follow, again: Stop). Following shows "Following Jo · Stop" under the header and in the bar, with a ring on their initial. A **⋯** menu opens Session (invite code and Copy, members, Remove, Unblock, End), Media (missing files, downloads, Locate, §10) and Settings (name, colour, overlay toggles, media folder, sound, the remembered close choice), each as a panel inside the strip.
- **Tabs, an iOS segmented control:** **Chat**: messages, with each change between them as a short grey line, one per action ("Jo · 10:42 · moved Interview_03 on V1"; quick changes in a row to the same thing by the same person merge). **Changes**: changes only, one line per property changed in an action with old → new ("start 01:00:10:00 → 01:00:12:04"), a linked video and audio pair and a drag's several updates shown once; a row of people's initials filters by person. Empty: "No changes yet in this session".
- **Clicking** a change line or a timecode in chat takes your Resolve there: that timeline, the playhead, the clip selected. The lists have **no undo buttons**: Ctrl+Z undoes your own changes newest first (§23.2).
- **History:** the host keeps the last 500 lines (chat and changes), sent to anyone who joins or rejoins, deleted when the session is ended for good.
- The Review screen (§9.3 questions) and the Not-in-a-session screen (host, resume, join) live in the same bar and strip.

### 24.4 Look (Apple's Human Interface Guidelines, as a dark HUD)
- **Material:** a dark translucent HUD: Windows 11's acrylic material (`backgroundMaterial`), the regular (text-heavy) variant, falling back to solid dark on Windows 10 and when Windows' transparency effects are off or contrast is raised. Glass only on the bar and strip themselves, never on cards or rows inside them (`liquid-glass.md`).
- **Type:** Segoe UI Variable, Windows' own system face (SF Pro may only be used on Apple platforms); Cascadia Mono for timecodes and codes. 13 px body, 11 px smallest.
- **Colour:** Apple's dark system colours: blue `#0A84FF` for actions (Follow, Send, Copy), orange `#FF9F0A` only for urgent items, people's colours from Apple's set in join order (blue, orange, green, pink, teal, yellow, indigo, red, mint, cyan); one or two tinted buttons per view at most. Dark only (Resolve is always dark).
- **Shapes:** window corners about 14 px, cards 10 px, pill buttons, grouped rows with hairline separators, a chevron for expand and collapse; controls at least 28 × 28.
- **Motion:** a short spring (about 0.3 s) for expanding and collapsing, urgent cards sliding up from the bar; none with reduced motion.

### 24.5 Verification
- The mockup reviewed against the guidelines (the apple-design skill) and approved by the user, before building. **Approved 2026-11-05.**
- **Bar probe, 2026-11-05: works** (findings "M8 bar probe"): the always-on-top acrylic bar stays above Resolve, other apps and Resolve's Full Screen Window.
- Then, as for the earlier milestones: unit tests for the history (grouping, the 500 lines, filtering), a real-Resolve check (presence, Follow, jumping to a change), and a two-PC checklist.
