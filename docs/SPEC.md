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
│   • Sync engine (Yjs document + operation log)                 │
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
- **Shared state:** Yjs document holding the session's model of the project, plus an ordered operation log kept by the host.
- **ffmpeg:** bundled, used only for proxies and media inspection.

### 3.2 Bridge ↔ companion channel
Resolve Free 21.1 Lua has no sockets or general file I/O. Measured on Free 21.1.2 for Windows (`docs/feasibility/findings-2026-11-02.md`):
- **Bridge → companion (works):** the bridge runs `fusion:Execute('error("RCFEAS|<key>|<hex>")')`. Resolve writes each error to `Support/logs/ResolveDebug.txt` immediately and the bridge keeps running. The companion follows the log. Payloads are hex and split into ≤1500-character chunks, because log lines are cut at ~2000 characters. Throughput: 200 messages in 17 ms, in order.
- **Companion → bridge (workaround, tested; approved 2026-11-02):** `loadfile`, `dofile`, `io`, `bmd.readfile` and `fusion:LoadPrefs` are all nil, so the bridge can't read request files.
  - *Small messages (normal edits):* the companion writes a copy of a real keyboard preset whose **file name** is the encoded message. The bridge runs `ImportKeyboardPreset`, reads the name from `GetKeyboardPresetList`, then `DeleteKeyboardPreset`. About 100–125 bytes and ~250–300 ms per message, and nothing in the project is touched.
  - *Large messages (catch-up):* an OTIO timeline whose marker notes carry the data, imported with `ImportTimelineFromFile` and deleted afterwards. ≥10 KB per message, ~370 ms. It switches the current timeline (the bridge must switch back), so it's only used while the editor is idle.
  - Inbound messages stay **data only**: decoded by the bridge's own parser, never executed.
- *Rejected:* `Fusion.prefs` via `SetPrefs`/`SavePrefs`. `SavePrefs` doesn't exist on Free, and the file is only written when Resolve restarts.
- **Protocol:** every request has a sequence number, a command, arguments and a timeout. Every response echoes the sequence number, plus a status (`ok` / `error` / `unsupported`) and its data. Requests older than 120 s are refused.
- **Liveness:** the bridge writes a heartbeat key every second. No heartbeat for 3 s means the bridge is not running (§9.4).

### 3.3 Change detection
- The API sends no change events, so the bridge **snapshots** the session project about every 300 ms and the companion diffs consecutive snapshots.
- Snapshot cost must be measured. Large projects may need incremental snapshots (open timeline every tick, other timelines and bins less often).
- A change the bridge itself applied on behalf of others is tagged, so it isn't mistaken for a local edit.
- Each detected local change becomes an **operation**, for example `clip.trim`, `clip.move`, `marker.add` or `bin.rename`, sent to the host.

### 3.4 Object identity
The same clip has different internal IDs on each PC. The companion keeps a mapping from a **collab ID** (assigned by the host) to each PC's local object:
- Media pool items: match by file fingerprint (§10.1). Store the collab ID in the item's third-party metadata if the API allows it on Free (to be verified).
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
| F1 | Bridge loop runs with Resolve responsive; bridge can read request files | Loop **yes** (52 ms worst gap). Reading files **no**; preset and timeline import tricks work instead (§3.2) |
| F2 | Outbound channel | `Fusion.prefs` **no**; error log via `fusion:Execute` **yes** (§3.2) |
| F3 | Script install path | `%APPDATA%\…\Support\Fusion\Scripts\Utility\` **yes**; `.py` not listed on Free. Don't put shared files under `%LOCALAPPDATA%` when started from a packaged app |
| F4 | Timeline / media pool edits on Free | **All needed edits work**, including trims, moves, track changes. Exception: bins can't be renamed (no `Folder.SetName`). `ImportMedia` only accepts plain paths |
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
| Companion → bridge | Keyboard-preset file names for edits; OTIO marker notes only for large idle-time transfers (§3.2) |
