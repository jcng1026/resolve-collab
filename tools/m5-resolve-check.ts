// One-PC check of M5 marker sync in real Resolve (SPEC §21.6). Resolve is
// the host; an in-process fake bridge is the member; they talk over a local
// DHT testnet, so nothing leaves this PC.
//
// Before running: open an EMPTY scratch project in Resolve (no timelines),
// install the bridge (node tools/install-bridge.ts) and start Workspace >
// Scripts > ResolveCollab. Then:
//   node tools/m5-resolve-check.ts                 every step, some by hand in Resolve
//   node tools/m5-resolve-check.ts --auto          only the steps that need no hands
//   node tools/m5-resolve-check.ts --force-tier 2  Resolve applies item changes by rebuilding items
//
// The member's edits are checked against what the bridge reads back from
// Resolve. Steps marked "In Resolve" wait for you to make the edit there.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { BridgeClient } from "../src/bridge/bridge-client.ts";
import { MouseWatch } from "../src/bridge/mouse-watch.ts";
import { FakeBridge } from "../src/bridge/fake-bridge.ts";
import type { FakeItem, FakeMarker } from "../src/bridge/fake-timelines.ts";
import { findFile, fingerprint } from "../src/media/fingerprint.ts";
import { PeerLink, newInviteCode } from "../src/peer/peer-link.ts";
import { Session } from "../src/session.ts";
import type { LocalMarker } from "../src/sync/marker.ts";
import type { LocalItem } from "../src/sync/timeline-identify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MEDIA = join(HERE, "..", "local", "feasibility", "media");
const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox"); // as installed by tools/install-bridge.ts
const AUTO = process.argv.includes("--auto");
const tierAt = process.argv.indexOf("--force-tier");
const FORCE = tierAt > 0 ? (Number(process.argv[tierAt + 1]) as 2) : undefined;

const say = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${message}`);
let failures = 0;

async function waitFor(what: string, check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      failures++;
      say(`FAIL  ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  say(`ok    ${what}`);
  return true;
}

const byHand = (minutes = 5) => minutes * 60_000;

const CLIPS = ["original.mp4", "spare.mp4"];
for (const name of CLIPS) {
  if (!existsSync(join(SOURCE_MEDIA, name))) throw new Error(`missing ${name}: run node tools/feasibility/prepare.ts first`);
}
const dir = mkdtempSync(join(tmpdir(), "rc-m5check-"));
const media = join(dir, "media");
mkdirSync(media);
mkdirSync(join(dir, "inbox"));
for (const name of CLIPS) copyFileSync(join(SOURCE_MEDIA, name), join(media, name));
writeFileSync(join(dir, "ResolveDebug.txt"), "");

const testnet = await createTestnet(3);
const code = newInviteCode();
const home = dirname(DEFAULT_INBOX);

// --- host: real Resolve -----------------------------------------------------------
const hostLogs: string[] = [];
const hostBridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
const hostPeers = new PeerLink(code, { bootstrap: testnet.bootstrap });
const mouse = new MouseWatch((m) => say(`host    ${m}`));
mouse.start();
const host = new Session({
  role: "host", bridge: hostBridge, peers: hostPeers,
  storeDir: join(home, "sessions", `m5check-${Date.now()}`), backupsDir: join(home, "backups"),
  ask: async () => new Map(), // the host is never asked in this check
  confirm: async () => true,
  fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { hostLogs.push(m); say(`host    ${m}`); },
  ...(FORCE ? { forceTier: FORCE } : {}),
  userBusy: () => mouse.held,
});

// --- member: fake bridge ----------------------------------------------------------
const fake = new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox"));
const memberLogs: string[] = [];
const memberBridge = new BridgeClient({ logPath: join(dir, "ResolveDebug.txt"), inboxDir: join(dir, "inbox"), pollMs: 20 });
const memberPeers = new PeerLink(code, { bootstrap: testnet.bootstrap });
const member = new Session({
  role: "member", bridge: memberBridge, peers: memberPeers,
  storeDir: join(dir, "member-store"), backupsDir: join(dir, "backups"),
  ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])),
  confirm: async () => true,
  fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { memberLogs.push(m); say(`member  ${m}`); },
});

// Resolve's state as the bridge reports it: the current timeline only.
const ft = fake.timelines;
const resolveTimeline = () => host.timelines.timelines.find((t) => t.id === host.timelines.current);
const resolveMarkers = (): LocalMarker[] => [...host.timelines.markers.values()];
const resolveMarker = (frame: number) => host.timelines.markers.get(frame);
const resolveItemAt = (start: number): LocalItem | undefined =>
  [...host.timelines.items.values()].find((i) => i.start === start && i.trackKind === "video" && i.kind === "clip");
const resolvePoolMarkers = (name: string): LocalMarker[] => [...host.sync.local.clips.values()].find((c) => c.name === name)?.markers ?? [];
const memberItemAt = (start: number): FakeItem | undefined => [...ft.timelineByName("RC M5 Edit")!.items.values()].find((i) => i.start === start && i.trackKind === "video");
const marker = (frame: number, extra: Partial<FakeMarker> = {}): FakeMarker => ({ frame, duration: 1, color: "Blue", name: `at ${frame}`, note: "", tag: "", ...extra });
const isTag = (tag: string) => /^rc:[0-9a-f]{32}$/.test(tag);
const same = (a: { frame: number; duration: number; color: string; name: string; note: string }, b: typeof a) =>
  a.frame === b.frame && a.duration === b.duration && a.color === b.color && a.name === b.name && a.note === b.note;

hostBridge.start();
memberBridge.start();
fake.start();
await Promise.all([hostPeers.start(), memberPeers.start()]);

say(`M5 check${FORCE ? ` with tier ${FORCE} forced` : ""}${AUTO ? " (automatic steps only)" : ""}`);
say("Waiting for the bridge in Resolve (Workspace > Scripts > ResolveCollab) ...");
await waitFor("bridge connected", () => hostBridge.connected, 120_000);
await waitFor("member joined", () => memberLogs.some((l) => l.startsWith("joined the session")));

say("STEP 1  member imports two clips and puts a marker on spare.mp4 in the media pool");
const pool = Object.fromEntries(CLIPS.map((n) => [n, fake.importClip(join(media, n)).id]));
fake.poolClips.get(pool["spare.mp4"]!)!.markers.push(marker(30, { color: "Cyan", name: "pool" }));
await waitFor("clips in Resolve's media pool", () => CLIPS.every((n) => [...host.sync.local.clips.values()].some((c) => c.name === n)));
await waitFor("pool marker on spare.mp4 in Resolve, tagged rc:p:", () => {
  const [m] = resolvePoolMarkers("spare.mp4");
  return !!m && same(m, marker(30, { color: "Cyan", name: "pool" })) && m.tag.startsWith("rc:p:");
}, 30_000);

say("STEP 2  member makes RC M5 Edit: two clips, three timeline markers, a marker on original.mp4");
const longNote = `naïve 🎬 "quotes" \\ / line\nsecond line ${"x".repeat(3000)}`;
const edit = ft.addTimeline("RC M5 Edit");
ft.addClip(edit, pool["original.mp4"]!, "original.mp4", 0, 120).markers.push(marker(5, { color: "Red", name: "on the clip" }));
ft.addClip(edit, pool["spare.mp4"]!, "spare.mp4", 200, 48);
edit.markers.push(marker(10, { note: longNote }), marker(100, { duration: 48, color: "Yellow" }), marker(5000, { color: "Cream", name: "past the end" }));
await waitFor("timeline created and open in Resolve", () => resolveTimeline()?.name === "RC M5 Edit");
await waitFor("three timeline markers in Resolve, as sent", () =>
  resolveMarkers().length === 3 && same(resolveMarker(10)!, marker(10, { note: longNote })) && same(resolveMarker(100)!, marker(100, { duration: 48, color: "Yellow" }))
  && same(resolveMarker(5000)!, marker(5000, { color: "Cream", name: "past the end" })), 30_000);
await waitFor("each tagged with its collab ID", () => resolveMarkers().every((m) => isTag(m.tag)));
await waitFor("marker on original.mp4 in Resolve", () => {
  const ms = resolveItemAt(0)?.markers ?? [];
  return ms.length === 1 && same(ms[0]!, marker(5, { color: "Red", name: "on the clip" })) && isTag(ms[0]!.tag);
}, 30_000);
// spare.mp4 was added by the companion: Resolve's copy of the pool marker is
// removed, and the member's copy (the session's item marker) is added instead.
await waitFor("spare.mp4 on the timeline has one copy of the pool marker, as an item marker", () => {
  const ms = resolveItemAt(200)?.markers ?? [];
  return ms.length === 1 && same(ms[0]!, marker(30, { color: "Cyan", name: "pool" })) && isTag(ms[0]!.tag);
}, 30_000);
await waitFor("the pool clip still has just its own marker", () => resolvePoolMarkers("spare.mp4").length === 1, 1000);

say("STEP 3  member moves and recolours a timeline marker, deletes one, and edits the clip marker's note");
const tag10 = resolveMarker(10)!.tag;
Object.assign(edit.markers.find((m) => m.frame === 10)!, { frame: 30, color: "Red", name: "moved" });
edit.markers.splice(edit.markers.findIndex((m) => m.frame === 100), 1);
memberItemAt(0)!.markers[0]!.note = "edited";
await waitFor("moved, recoloured and still the same marker in Resolve", () => {
  const m = resolveMarker(30);
  return !resolveMarker(10) && m?.color === "Red" && m.name === "moved" && m.note === longNote && m.tag === tag10;
}, 30_000);
await waitFor("deleted in Resolve", () => !resolveMarker(100) && resolveMarkers().length === 2);
await waitFor("clip marker's note in Resolve", () => resolveItemAt(0)?.markers?.[0]?.note === "edited");

say("STEP 4  member changes the pool marker");
fake.poolClips.get(pool["spare.mp4"]!)!.markers[0]!.color = "Mint";
await waitFor("pool marker recoloured in Resolve", () => resolvePoolMarkers("spare.mp4")[0]?.color === "Mint", 30_000);

if (FORCE === 2) {
  say("STEP 5  member moves original.mp4: Resolve rebuilds it (tier 2), and its marker comes back");
  memberItemAt(0)!.start = 300;
  ft.itemByName(edit, "original.mp4", "audio")!.start = 300;
  await waitFor("rebuilt at its new place with its marker", () => {
    const ms = resolveItemAt(300)?.markers ?? [];
    return ms.length === 1 && ms[0]!.note === "edited";
  }, 30_000);
  await waitFor("its marker still on the member", () => memberItemAt(300)?.markers.length === 1, 5000);
}

if (!AUTO) {
  say("STEP 6  In Resolve: on RC M5 Edit, put the playhead somewhere without a marker and press M (add a marker)");
  const before = new Set(resolveMarkers().map((m) => m.frame));
  await waitFor("the member got it", () => edit.markers.length === 3, byHand());
  const added = resolveMarkers().find((m) => !before.has(m.frame));
  await waitFor("Resolve's new marker tagged", () => !!added && isTag(host.timelines.markers.get(added.frame)?.tag ?? ""), 10_000);
  say("STEP 7  In Resolve: drag that marker along the ruler, then double-click it and pick another colour");
  const tag = host.timelines.markers.get(added!.frame)!.tag;
  await waitFor("moved and recoloured on the member", () => {
    const m = edit.markers.find((x) => x.tag === tag);
    return !!m && m.frame !== added!.frame && m.color !== added!.color;
  }, byHand());
  say("STEP 8  In Resolve: delete the marker named \"moved\" (select it on the ruler and press Delete, or Remove Marker in its dialog)");
  await waitFor("the member lost it", () => !edit.markers.some((m) => m.name === "moved"), byHand());
}

say("STEP 9  compare Resolve and the member");
await new Promise((r) => setTimeout(r, 2000));
const describe = (ms: { frame: number; duration: number; color: string; name: string; note: string }[]) =>
  ms.map((m) => `${m.frame}|${m.duration}|${m.color}|${m.name}|${m.note.length}`).sort();
const items = (list: { start: number; trackKind: string; markers?: { frame: number; duration: number; color: string; name: string; note: string }[] }[]) =>
  list.filter((i) => i.trackKind === "video").map((i) => `${i.start}: ${describe(i.markers ?? []).join(", ")}`).sort();
const inResolve = { timeline: describe(resolveMarkers()), items: items([...host.timelines.items.values()]), pool: describe(resolvePoolMarkers("spare.mp4")) };
const inMember = { timeline: describe(edit.markers), items: items([...edit.items.values()]), pool: describe(fake.poolClips.get(pool["spare.mp4"]!)!.markers) };
say(`Resolve: ${JSON.stringify(inResolve)}`);
say(`member:  ${JSON.stringify(inMember)}`);
await waitFor("markers match", () => JSON.stringify(inResolve) === JSON.stringify(inMember), 1000);

const errors = [...hostLogs, ...memberLogs].filter((l) => /error|failed|couldn't|refused|NOT/i.test(l));
if (errors.length) say(`log lines to look at:\n  ${errors.join("\n  ")}`);
say(failures ? `${failures} check(s) FAILED` : "all checks passed");

host.stop();
mouse.stop();
hostBridge.stop();
member.stop();
memberBridge.stop();
fake.stop();
await Promise.all([hostPeers.stop(), memberPeers.stop()]);
await testnet.destroy();
process.exit(failures ? 1 : 0);
