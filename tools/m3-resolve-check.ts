// One-PC check of the M3 media pool bridge in real Resolve (SPEC §19.7).
// Resolve is the host; an in-process fake bridge is the member; they talk
// over a local DHT testnet, so nothing leaves this PC.
//
// Before running: open an EMPTY scratch project in Resolve, install the
// bridge (node tools/install-bridge.ts) and start Workspace > Scripts >
// ResolveCollab. Then: node tools/m3-resolve-check.ts
//
// The member's edits are checked against what the bridge reads back from
// Resolve. Steps marked "In Resolve" wait for you to make the edit there.
// At the end a fresh bridge client attaches to the still-running bridge
// (as after a companion restart) and compares a full snapshot with the
// member's pool.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import type { JsonValue } from "../src/bridge-protocol/wire.ts";
import { BridgeClient } from "../src/bridge/bridge-client.ts";
import { FakeBridge } from "../src/bridge/fake-bridge.ts";
import { findFile, fingerprint } from "../src/media/fingerprint.ts";
import { PeerLink, newInviteCode } from "../src/peer/peer-link.ts";
import { Session } from "../src/session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MEDIA = join(HERE, "..", "local", "feasibility", "media");
const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox"); // as installed by tools/install-bridge.ts

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

for (const name of ["spare.mp4", "alt.mp4"]) {
  if (!existsSync(join(SOURCE_MEDIA, name))) throw new Error(`missing ${name}: run node tools/feasibility/prepare.ts first`);
}
const dir = mkdtempSync(join(tmpdir(), "rc-m3check-"));
const media = join(dir, "media");
mkdirSync(media);
mkdirSync(join(dir, "inbox"));
for (const name of ["spare.mp4", "alt.mp4"]) copyFileSync(join(SOURCE_MEDIA, name), join(media, name));
writeFileSync(join(dir, "ResolveDebug.txt"), "");

const testnet = await createTestnet(3);
const code = newInviteCode();
const home = dirname(DEFAULT_INBOX);

// --- host: real Resolve -----------------------------------------------------------
const hostLogs: string[] = [];
const hostBridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
const hostPeers = new PeerLink(code, { bootstrap: testnet.bootstrap });
const host = new Session({
  role: "host", bridge: hostBridge, peers: hostPeers, name: "Resolve", approve: async () => "yes",
  storeDir: join(dir, "host-store"), backupsDir: join(home, "backups"),
  ask: async () => new Map(), // the host is never asked in this check
  confirm: async () => true,
  fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { hostLogs.push(m); say(`host    ${m}`); },
});

// --- member: fake bridge ----------------------------------------------------------
const fake = new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox"));
const memberLogs: string[] = [];
const memberBridge = new BridgeClient({ logPath: join(dir, "ResolveDebug.txt"), inboxDir: join(dir, "inbox"), pollMs: 20 });
const memberPeers = new PeerLink(code, { bootstrap: testnet.bootstrap });
const member = new Session({
  role: "member", bridge: memberBridge, peers: memberPeers, name: "Fake member",
  storeDir: join(dir, "member-store"), backupsDir: join(dir, "backups"),
  ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])),
  confirm: async () => true,
  fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { memberLogs.push(m); say(`member  ${m}`); },
});

const resolveClip = (name: string) => [...host.sync.local.clips.values()].find((c) => c.name === name);
const resolveBin = (name: string) => [...host.sync.local.bins.values()].find((b) => b.name === name);
const resolveBinName = (id: string | undefined) => (id ? host.sync.local.bins.get(id)?.name : undefined);

hostBridge.start();
memberBridge.start();
fake.start();
await Promise.all([hostPeers.start(), memberPeers.start()]);

say("Waiting for the bridge in Resolve (Workspace > Scripts > ResolveCollab) ...");
await waitFor("bridge connected", () => hostBridge.connected, 120_000);
await waitFor("member joined", () => memberLogs.some((l) => l.startsWith("joined the session")));
await new Promise((r) => setTimeout(r, 2000)); // first join settles

// --- member → Resolve -------------------------------------------------------------
say("STEP 1  member makes a bin and imports a clip into it, with colour, flag and metadata");
const footage = fake.addBin("RC Footage");
const spare = fake.importClip(join(media, "spare.mp4"), footage.id);
spare.color = "Orange";
spare.flags = ["Blue"];
spare.meta.Scene = "7";
await waitFor("bin in Resolve", () => !!resolveBin("RC Footage"));
await waitFor("clip imported into it", () => resolveBinName(resolveClip("spare.mp4")?.bin) === "RC Footage");
await waitFor("colour, flag and metadata read back", () => {
  const c = resolveClip("spare.mp4");
  return c?.color === "Orange" && c.flags.join() === "Blue" && c.meta.Scene === "7";
});

say("STEP 2  member imports a second clip at the top level");
const alt = fake.importClip(join(media, "alt.mp4"));
await waitFor("alt.mp4 in Resolve's Master bin", () => !host.sync.local.bins.get(resolveClip("alt.mp4")?.bin ?? "")?.parent && !!resolveClip("alt.mp4"));

say("STEP 3  member renames the clip");
spare.name = "spare (renamed)";
await waitFor("clip renamed in Resolve", () => !!resolveClip("spare (renamed)"));

say("STEP 4  member renames the bin (emulated in Resolve)");
footage.name = "RC Day 1";
await waitFor("bin renamed in Resolve", () => !!resolveBin("RC Day 1") && !resolveBin("RC Footage"));
await waitFor("clip followed the renamed bin", () => resolveBinName(resolveClip("spare (renamed)")?.bin) === "RC Day 1");

say("STEP 5  member makes a sub-bin, moves it into RC Day 1, and moves alt.mp4 into it");
const sub = fake.addBin("RC Sub");
await waitFor("sub-bin in Resolve", () => !!resolveBin("RC Sub"));
sub.parent = footage.id;
await waitFor("sub-bin moved", () => resolveBinName(resolveBin("RC Sub")?.parent) === "RC Day 1");
alt.bin = sub.id;
await waitFor("clip moved into the sub-bin", () => resolveBinName(resolveClip("alt.mp4")?.bin) === "RC Sub");

say("STEP 6  member clears the metadata and the flag, and changes the colour");
delete spare.meta.Scene;
spare.flags = [];
spare.color = "Teal";
await waitFor("cleared and recoloured in Resolve", () => {
  const c = resolveClip("spare (renamed)");
  return c?.color === "Teal" && c.flags.length === 0 && !c.meta.Scene;
});

say("STEP 7  backup .drp of the open project");
const backupPath = join(home, "backups", `m3-check-${Date.now()}.drp`);
const backup = await hostBridge.send({ type: "project.backup", path: backupPath });
await waitFor(`backup written (${JSON.stringify(backup)})`, () => backup.ok && existsSync(backupPath), 1000);
const outside = await hostBridge.send({ type: "project.backup", path: join(dir, "outside.drp") });
await waitFor(`backup outside the backups folder refused (${outside.error})`, () => !outside.ok && !existsSync(join(dir, "outside.drp")), 1000);

// --- Resolve → member -------------------------------------------------------------
say("STEP 8  In Resolve: create a bin at the top level and name it  RC From Resolve");
await waitFor("member got the bin", () => !!fake.binByName("RC From Resolve"), 300_000);
say("STEP 9  In Resolve: set the colour of  alt.mp4  (in RC Day 1 > RC Sub) to Green");
await waitFor("member got the colour", () => fake.clipByName("alt.mp4")?.color === "Green", 300_000);
say("STEP 10 In Resolve: rename the bin  RC From Resolve  to  RC Renamed");
await waitFor("member got the rename", () => !!fake.binByName("RC Renamed") && !fake.binByName("RC From Resolve"), 300_000);
say("STEP 11 In Resolve: drag  spare (renamed)  into  RC Renamed");
await waitFor("member got the move", () => fake.bins.get(fake.clipByName("spare (renamed)")?.bin ?? "")?.name === "RC Renamed", 300_000);

// --- deletes ----------------------------------------------------------------------
say("STEP 12 member deletes alt.mp4, then the sub-bin");
fake.poolClips.delete(alt.id);
await waitFor("clip deleted in Resolve", () => !resolveClip("alt.mp4"));
fake.deleteBin(sub.id);
await waitFor("sub-bin deleted in Resolve", () => !resolveBin("RC Sub"));

// --- companion restart ------------------------------------------------------------
say("STEP 13 restart the host's companion while the bridge keeps running, and compare snapshots");
await new Promise((r) => setTimeout(r, 2000));
host.stop();
hostBridge.stop();
const fresh = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
const bins = new Map<string, { name: string; parent: string }>();
const clips = new Map<string, { name: string; bin: string; color: string }>();
let synced = false;
fresh.on("event", (e: Record<string, JsonValue>) => {
  if (e.type === "mp.bin") bins.set(String(e.id), { name: String(e.name), parent: String(e.parent) });
  if (e.type === "mp.clip") clips.set(String(e.id), { name: String(e.name), bin: String(e.bin), color: String(e.color) });
  if (e.type === "mp.synced") synced = true;
});
let attached = false;
fresh.on("attached", () => { attached = true; });
fresh.start();
const snapshot = await fresh.send({ type: "mp.snapshot" });
await waitFor(`attached to the running bridge and snapshot accepted (${JSON.stringify(snapshot)})`, () => attached && snapshot.ok, 1000);
await waitFor("snapshot complete", () => synced);
const describeResolve = [...clips.values()].map((c) => `${c.name}|${bins.get(c.bin)?.name}|${c.color}`).sort();
const describeMember = [...fake.poolClips.values()].map((c) => `${c.name}|${fake.bins.get(c.bin)?.name}|${c.color}`).sort();
const binsResolve = [...bins.values()].filter((b) => b.parent).map((b) => b.name).sort();
const binsMember = [...fake.bins.values()].filter((b) => b.parent).map((b) => b.name).sort();
say(`Resolve clips: ${JSON.stringify(describeResolve)}  bins: ${JSON.stringify(binsResolve)}`);
say(`member  clips: ${JSON.stringify(describeMember)}  bins: ${JSON.stringify(binsMember)}`);
await waitFor("Resolve and the member match", () =>
  JSON.stringify(describeResolve) === JSON.stringify(describeMember) && JSON.stringify(binsResolve) === JSON.stringify(binsMember), 1000);

const errors = [...hostLogs, ...memberLogs].filter((l) => /error|failed|refused|NOT/i.test(l));
if (errors.length) say(`log lines to look at:\n  ${errors.join("\n  ")}`);
say(failures ? `${failures} check(s) FAILED` : "all checks passed");

fresh.stop();
member.stop();
memberBridge.stop();
fake.stop();
await Promise.all([hostPeers.stop(), memberPeers.stop()]);
await testnet.destroy();
process.exit(failures ? 1 : 0);
