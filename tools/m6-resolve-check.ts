// One-PC check of M6 sessions in real Resolve (SPEC §22.6). This time Resolve
// is the MEMBER joining a session; an in-process fake bridge is the host.
// They talk over a local DHT testnet, so nothing leaves this PC.
//
// Before running: have any project open in Resolve (it is left as it is),
// install the bridge (node tools/install-bridge.ts) and start Workspace >
// Scripts > ResolveCollab. Close any companion. Then:
//   node tools/m6-resolve-check.ts
//
// It checks: a first join makes and opens a new project named after the
// host's, and sync fills it; the host closing ends the session for Resolve's
// companion; the host resuming with a new code lets Resolve's PC back in
// without asking, into the same project.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { localBridgeBuild } from "../src/bridge/bridge-build.ts";
import { BridgeClient } from "../src/bridge/bridge-client.ts";
import { FakeBridge } from "../src/bridge/fake-bridge.ts";
import { findFile, fingerprint } from "../src/media/fingerprint.ts";
import { PeerLink, newInviteCode } from "../src/peer/peer-link.ts";
import { Session } from "../src/session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_MEDIA = join(HERE, "..", "local", "feasibility", "media");
const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox");

const say = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${message}`);
let failures = 0;

async function waitFor(what: string, check: () => boolean, ms = 30_000): Promise<boolean> {
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

const CLIP = "original.mp4";
if (!existsSync(join(SOURCE_MEDIA, CLIP))) throw new Error(`missing ${CLIP}: run node tools/feasibility/prepare.ts first`);
const dir = mkdtempSync(join(tmpdir(), "rc-m6check-"));
const media = join(dir, "media");
mkdirSync(media);
mkdirSync(join(dir, "inbox"));
copyFileSync(join(SOURCE_MEDIA, CLIP), join(media, CLIP));
writeFileSync(join(dir, "ResolveDebug.txt"), "");
const testnet = await createTestnet(3);

// --- host: fake bridge, with a clip and a timeline ------------------------------
const hostFake = new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox"));
hostFake.project = { id: "m6-host-project", name: "RC M6 Host" };
const clip = hostFake.importClip(join(media, CLIP));
hostFake.timelines.addClip(hostFake.timelines.addTimeline("RC M6 Edit"), clip.id, CLIP, 0, 48);
hostFake.start();
const hostLogs: string[] = [];
const hostSeed = Buffer.alloc(32, 7);
const hostStore = join(dir, "host-store");
let host: Session | undefined;
let hostBridge: BridgeClient | undefined;
let hostPeers: PeerLink | undefined;
let asked = 0;
async function startHost(code: string, resume: boolean): Promise<void> {
  hostBridge = new BridgeClient({ logPath: join(dir, "ResolveDebug.txt"), inboxDir: join(dir, "inbox"), pollMs: 20 });
  hostPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: hostSeed });
  host = new Session({
    role: "host", bridge: hostBridge, peers: hostPeers, storeDir: hostStore, backupsDir: join(dir, "backups"), name: "Fake host", resume,
    approve: async () => { asked++; return "yes"; },
    ask: async () => new Map(), confirm: async () => true, fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
    log: (m) => { hostLogs.push(m); say(`host    ${m}`); },
  });
  hostBridge.start();
  await hostPeers.start();
}
async function stopHost(): Promise<void> {
  await host!.close();
  hostBridge!.stop();
  await hostPeers!.stop();
}

// --- member: real Resolve -------------------------------------------------------
const memberLogs: string[] = [];
const memberStore = join(dir, "member-store");
const memberSeed = Buffer.alloc(32, 9);
let member: Session | undefined;
let memberBridge: BridgeClient | undefined;
let memberPeers: PeerLink | undefined;
let memberEnded: string | undefined;
async function startMember(code: string): Promise<void> {
  memberEnded = undefined;
  memberBridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
  memberPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: memberSeed });
  member = new Session({
    role: "member", bridge: memberBridge, peers: memberPeers, storeDir: memberStore, backupsDir: join(homedir(), "ResolveCollab", "backups"),
    name: "Resolve", onEnded: (why) => { memberEnded = why; },
    ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])), confirm: async () => true,
    fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
    log: (m) => { memberLogs.push(m); say(`member  ${m}`); }, bridgeBuild: localBridgeBuild(),
  });
  memberBridge.start();
  await memberPeers.start();
}
async function stopMember(): Promise<void> {
  await member!.close();
  memberBridge!.stop();
  await memberPeers!.stop();
}

const resolveProject = () => member?.sync?.projectId;
const resolveClip = () => [...(member?.sync?.local.clips.values() ?? [])].some((c) => c.name === CLIP);
const resolveTimeline = () => member?.timelines?.timelines.some((t) => t.name === "RC M6 Edit") ?? false;

say("M6 check: Resolve joins a session hosted by a fake PC");
const first = newInviteCode();
await startHost(first, false);
say("STEP 1  Resolve's companion joins: a first join");
await startMember(first);
await waitFor("bridge connected", () => memberBridge!.connected, 120_000);
await waitFor("let in", () => memberLogs.some((l) => l.startsWith("joined the session hosted by Fake host")), 60_000);
await waitFor('Resolve made "RC M6 Host (collab · hosted by Fake host)" and opened it',
  () => memberLogs.some((l) => l.startsWith('made the project "RC M6 Host (collab · hosted by Fake host)'))
    && member!.sync.paused === false && member!.sync.projectId === member!.record?.project);
const project = resolveProject();
await waitFor("the host's clip in Resolve's media pool", resolveClip, 60_000);
await waitFor("the host's timeline in Resolve", resolveTimeline, 60_000);
await waitFor("asked once", () => asked === 1, 1000);

say("STEP 2  the host closes: the session ends for Resolve's companion");
await stopHost();
await waitFor("told", () => memberEnded?.startsWith("Fake host closed the session") === true, 10_000);
await stopMember();

say("STEP 3  the host resumes with a new code; Resolve's PC rejoins without being asked, in the same project");
const second = newInviteCode();
await startHost(second, true);
await waitFor("host resumed", () => hostLogs.some((l) => l.startsWith("resuming the session")), 20_000);
await startMember(second);
await waitFor("rejoined", () => memberLogs.some((l) => l.startsWith("rejoined the session")), 60_000);
await waitFor("same project, not asked again", () => resolveProject() === project && asked === 1, 5000);
clip.color = "Orange";
await waitFor("edits sync again", () => [...member!.sync.local.clips.values()].some((c) => c.name === CLIP && c.color === "Orange"), 30_000);

const errors = [...hostLogs, ...memberLogs].filter((l) => /error|failed|couldn't|refused|NOT/i.test(l));
if (errors.length) say(`log lines to look at:\n  ${errors.join("\n  ")}`);
say(failures ? `${failures} check(s) FAILED` : "all checks passed");
say(`Resolve now has the project "${member!.record?.projectName}" open; the project open before is unchanged.`);
await stopMember();
await stopHost();
hostFake.stop();
await testnet.destroy();
process.exit(failures ? 1 : 0);
