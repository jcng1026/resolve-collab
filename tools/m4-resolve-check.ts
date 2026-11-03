// One-PC check of M4 timeline sync in real Resolve (SPEC §20.8). Resolve is
// the host; an in-process fake bridge is the member; they talk over a local
// DHT testnet, so nothing leaves this PC.
//
// Before running: open an EMPTY scratch project in Resolve (no timelines),
// install the bridge (node tools/install-bridge.ts) and start Workspace >
// Scripts > ResolveCollab. Then:
//   node tools/m4-resolve-check.ts                 every step, some by hand in Resolve
//   node tools/m4-resolve-check.ts --auto          only the steps that need no hands
//   node tools/m4-resolve-check.ts --force-tier 2  Resolve applies changes by rebuilding items
//   node tools/m4-resolve-check.ts --auto --drag   automatic steps plus the held-drag step
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
import type { FakeItem } from "../src/bridge/fake-timelines.ts";
import { findFile, fingerprint } from "../src/media/fingerprint.ts";
import { PeerLink, newInviteCode } from "../src/peer/peer-link.ts";
import { Session } from "../src/session.ts";
import type { LocalItem } from "../src/sync/timeline-identify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MEDIA = join(HERE, "..", "local", "feasibility", "media");
const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox"); // as installed by tools/install-bridge.ts
const AUTO = process.argv.includes("--auto");
const DRAG = !AUTO || process.argv.includes("--drag");
const tierAt = process.argv.indexOf("--force-tier");
const FORCE = tierAt > 0 ? (Number(process.argv[tierAt + 1]) as 2 | 3) : undefined;

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

const CLIPS = ["spare.mp4", "alt.mp4", "original.mp4", "fps30.mp4"];
for (const name of CLIPS) {
  if (!existsSync(join(SOURCE_MEDIA, name))) throw new Error(`missing ${name}: run node tools/feasibility/prepare.ts first`);
}
const dir = mkdtempSync(join(tmpdir(), "rc-m4check-"));
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
  // Under the ResolveCollab folder: the bridge only reads swap files there.
  storeDir: join(home, "sessions", `m4check-${Date.now()}`), backupsDir: join(home, "backups"),
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
const resolveItem = (name: string, kind: "video" | "audio" = "video"): LocalItem | undefined =>
  [...host.timelines.items.values()].find((i) => i.name === name && i.trackKind === kind);
const resolveKind = (kind: string): LocalItem[] => [...host.timelines.items.values()].filter((i) => i.kind === kind);
const memberItem = (name: string, kind: "video" | "audio" = "video", timeline = "RC M4 Edit"): FakeItem | undefined => {
  const t = ft.timelineByName(timeline);
  return t && ft.itemByName(t, name, kind);
};

hostBridge.start();
memberBridge.start();
fake.start();
await Promise.all([hostPeers.start(), memberPeers.start()]);

say(`M4 check${FORCE ? ` with tier ${FORCE} forced` : ""}${AUTO ? " (automatic steps only)" : ""}`);
say("Waiting for the bridge in Resolve (Workspace > Scripts > ResolveCollab) ...");
await waitFor("bridge connected", () => hostBridge.connected, 120_000);
await waitFor("member joined", () => memberLogs.some((l) => l.startsWith("joined the session")));

say("STEP 1  member imports three clips into the media pool");
const pool = Object.fromEntries(CLIPS.map((n) => [n, fake.importClip(join(media, n)).id]));
await waitFor("clips in Resolve's media pool", () => CLIPS.every((n) => [...host.sync.local.clips.values()].some((c) => c.name === n)));

say("STEP 2  member makes timeline RC M4 Edit with two clips (video + linked audio)");
const edit = ft.addTimeline("RC M4 Edit");
ft.addClip(edit, pool["spare.mp4"]!, "spare.mp4", 0, 48);
ft.addClip(edit, pool["alt.mp4"]!, "alt.mp4", 96, 48);
await waitFor("timeline created and open in Resolve", () => resolveTimeline()?.name === "RC M4 Edit");
await waitFor("both clips with audio in Resolve", () =>
  resolveItem("spare.mp4")?.start === 0 && resolveItem("alt.mp4")?.start === 96 && !!resolveItem("spare.mp4", "audio") && !!resolveItem("alt.mp4", "audio"), 30_000);
await waitFor("video and audio linked in Resolve", () => (resolveItem("spare.mp4")?.linked.length ?? 0) > 0);

say("STEP 3  member trims, moves, zooms, colours and disables");
memberItem("spare.mp4")!.duration = 40;
memberItem("spare.mp4")!.color = "Orange";
const alt = memberItem("alt.mp4")!;
alt.start = 120;
alt.props = { ...alt.props, ZoomX: 1.5 };
alt.enabled = false;
await waitFor("trim and colour in Resolve", () => resolveItem("spare.mp4")?.duration === 40 && resolveItem("spare.mp4")?.color === "Orange");
await waitFor("move, zoom and disable in Resolve", () => {
  const a = resolveItem("alt.mp4");
  return a?.start === 120 && a.props?.ZoomX === 1.5 && a.enabled === false;
});

say("STEP 4  member adds track Titles and a 300-frame Text+ title with words");
edit.video.push({ name: "Titles", enabled: true, locked: false, subType: "" });
ft.addItem(edit, { kind: "textplus", trackKind: "video", trackIndex: 2, start: 200, duration: 300, name: "Text+", template: "Text+",
  text: { styled: "RC M4 ü", font: "Open Sans", style: "Regular", size: 0.12 } });
await waitFor("Text+ in Resolve with its words and length", () => {
  const t = resolveKind("textplus")[0];
  return t?.start === 200 && t.duration === 300 && t.trackIndex === 2 && t.text?.styled === "RC M4 ü";
}, 30_000);

say("STEP 5  member adds a basic Text title (60 frames) and a Solid Color generator (36 frames)");
ft.addItem(edit, { kind: "title", trackKind: "video", trackIndex: 2, start: 600, duration: 60, name: "Text", template: "Text" });
ft.addItem(edit, { kind: "generator", trackKind: "video", trackIndex: 2, start: 700, duration: 36, name: "Solid Color", template: "Solid Color" });
await waitFor("title and generator placed at their lengths", () =>
  resolveKind("title").some((t) => t.start === 600 && t.duration === 60) && resolveKind("generator").some((g) => g.start === 700 && g.duration === 36), 30_000);
await waitFor("warnings about title words and generator settings", () =>
  hostLogs.some((l) => l.includes("its words don't sync")) && hostLogs.some((l) => l.includes("settings (e.g. colour) don't sync")));

say("STEP 6  member adds a Cross Dissolve at the start of spare.mp4");
ft.addItem(edit, { kind: "transition", trackKind: "video", trackIndex: 1, start: 0, duration: 12, name: "Cross Dissolve", template: "Cross Dissolve", alignment: "right" });
await waitFor("transition in Resolve", () => resolveKind("transition").length === 1, 30_000);

say("STEP 7  member fades in alt.mp4 over 10 frames");
memberItem("alt.mp4")!.fadeIn = 10;
await waitFor("fade in Resolve", () => resolveItem("alt.mp4")?.fadeIn === 10);

// Resolve counts a clip's source in its own frames, and trims in the
// timeline's: a 30 fps clip on this 24 fps timeline must still come out right.
say("STEP 7b member adds a 30 fps clip (48 frames from frame 24), then trims it to 36");
const thirty = ft.addClip(edit, pool["fps30.mp4"]!, "fps30.mp4", 900, 48);
thirty.srcStart = 24;
ft.itemByName(edit, "fps30.mp4", "audio")!.srcStart = 24;
await waitFor("30 fps clip in Resolve at its length", () => {
  const c = resolveItem("fps30.mp4");
  return c?.start === 900 && c.duration === 48 && c.srcStart === 24 && resolveItem("fps30.mp4", "audio")?.duration === 48;
}, 30_000);
memberItem("fps30.mp4")!.duration = 36;
memberItem("fps30.mp4", "audio")!.duration = 36;
await waitFor("30 fps clip trimmed in Resolve", () =>
  resolveItem("fps30.mp4")?.duration === 36 && resolveItem("fps30.mp4")?.srcStart === 24 && resolveItem("fps30.mp4", "audio")?.duration === 36);

// What crashed Resolve in the two-PC test: a clip held mid-drag over the
// timeline while another PC's edits arrived.
if (DRAG) {
  say("STEP 7c In Resolve: drag original.mp4 from the media pool onto Video 1 after the last clip, HOLD it there about 5 s, then drop it.");
  say("        Meanwhile the member keeps moving alt.mp4 and changing its colour.");
  const colours = ["Blue", "Pink", "Teal"];
  let n = 0;
  const altItem = memberItem("alt.mp4")!;
  const altAudio = memberItem("alt.mp4", "audio")!;
  const nudge = setInterval(() => {
    n++;
    altItem.color = colours[n % colours.length]!;
    altItem.start = altAudio.start = n % 2 ? 160 : 150;
  }, 700);
  let wasHeld = false;
  const watchHeld = setInterval(() => { wasHeld ||= mouse.held; }, 50);
  await waitFor("the member got the dropped clip", () => !!memberItem("original.mp4") && !mouse.held, byHand());
  clearInterval(nudge);
  clearInterval(watchHeld);
  await waitFor("the mouse was seen held during the drag", () => wasHeld, 1000);
  await waitFor("Resolve still answering, with the member's last move and colour", () =>
    resolveItem("alt.mp4")?.start === altItem.start && resolveItem("alt.mp4")?.color === altItem.color, 30_000);
  const dropped = resolveItem("original.mp4")!;
  await waitFor("the dropped clip's place and length on the member", () =>
    memberItem("original.mp4")?.start === dropped.start && memberItem("original.mp4")?.duration === dropped.duration, 10_000);
}

if (!AUTO) {
  say("STEP 8  In Resolve: on the RC M4 Edit timeline, set the clip colour of spare.mp4 to Green");
  await waitFor("member got the colour", () => memberItem("spare.mp4")?.color === "Green", byHand());
  say("STEP 9  In Resolve: delete the Solid Color generator from the timeline");
  await waitFor("member lost the generator", () => !memberItem("Solid Color"), byHand());

  say("STEP 10 member makes a second timeline, RC M4 Other, while Resolve stays on RC M4 Edit");
  const other = ft.addTimeline("RC M4 Other");
  ft.addClip(other, pool["original.mp4"]!, "original.mp4", 24, 48);
  await waitFor("RC M4 Other listed in Resolve, its clip waiting", () =>
    host.timelines.timelines.some((t) => t.name === "RC M4 Other") && hostLogs.some((l) => l.includes('changes to "RC M4 Other" will be applied')), 30_000);
  ft.current = edit.id; // the member goes back to Edit
  say("STEP 11 In Resolve: open the RC M4 Other timeline (double-click it in the media pool)");
  await waitFor("its clip applied once opened", () => resolveTimeline()?.name === "RC M4 Other" && resolveItem("original.mp4")?.start === 24, byHand());
  say("STEP 12 In Resolve: open RC M4 Edit again");
  await waitFor("back on RC M4 Edit", () => resolveTimeline()?.name === "RC M4 Edit", byHand());

  say("STEP 13 In Resolve: open another project, then reopen this one (Resolve forgets fades set by scripts)");
  await waitFor("fade put back after reopening", () => hostLogs.some((l) => l.includes("Back on")) && resolveItem("alt.mp4")?.fadeIn === 10, byHand(8));
  await new Promise((r) => setTimeout(r, 2000));
  await waitFor("the member's fade was never removed", () => memberItem("alt.mp4")?.fadeIn === 10, 1000);
}

say("STEP 14 the bridge's tier-3 commands: export RC M4 Edit and swap it back in");
const localEdit = host.timelines.localTimelineOf(host.timelines.timelines.find((t) => t.name === "RC M4 Edit")!.rcId)!;
const drt = join(home, "sessions", `m4check-swap-${Date.now()}.drt`);
mkdirSync(dirname(drt), { recursive: true });
const exported = await hostBridge.send({ type: "tl.export", id: localEdit, path: drt });
await waitFor(`exported (${JSON.stringify(exported)})`, () => exported.ok && existsSync(drt), 1000);
const before = [...host.timelines.items.values()].map((i) => `${i.kind}|${i.trackKind}${i.trackIndex}|${i.start}|${i.duration}`).sort();
const swapped = await hostBridge.send({ type: "tl.swap", id: localEdit, path: drt, rcId: host.timelines.timelines.find((t) => t.id === localEdit)!.rcId, name: "RC M4 Edit" });
await waitFor(`swapped (${JSON.stringify(swapped)})`, () => swapped.ok, 1000);
await waitFor("same name, collab ID and items after the swap, still current", () => {
  const t = resolveTimeline();
  const after = [...host.timelines.items.values()].map((i) => `${i.kind}|${i.trackKind}${i.trackIndex}|${i.start}|${i.duration}`).sort();
  return t?.name === "RC M4 Edit" && t.id !== localEdit && JSON.stringify(after) === JSON.stringify(before);
}, 30_000);
const outside = await hostBridge.send({ type: "tl.export", id: resolveTimeline()!.id, path: join(dir, "outside.drt") });
await waitFor(`export outside the ResolveCollab folder refused (${outside.error})`, () => !outside.ok, 1000);

say("STEP 15 member edits after the swap still reach Resolve");
memberItem("alt.mp4")!.start = 150;
await waitFor("move after the swap", () => resolveItem("alt.mp4")?.start === 150, 30_000);

say("STEP 16 compare Resolve and the member");
await new Promise((r) => setTimeout(r, 2000));
const describe = (items: { kind: string; trackKind: string; trackIndex: number; start: number; duration: number }[]) =>
  items.map((i) => `${i.kind}|${i.trackKind}${i.trackIndex}|${i.start}|${i.duration}`).sort();
const inResolve = describe([...host.timelines.items.values()]);
const inMember = describe([...edit.items.values()]);
say(`Resolve: ${JSON.stringify(inResolve)}`);
say(`member:  ${JSON.stringify(inMember)}`);
await waitFor("RC M4 Edit matches", () => JSON.stringify(inResolve) === JSON.stringify(inMember), 1000);

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
