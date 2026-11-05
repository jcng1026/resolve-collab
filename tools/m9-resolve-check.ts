// One-PC check of M9 in real Resolve (SPEC §25). Resolve is a MEMBER of a
// session hosted by an in-process fake host that has a clip Resolve doesn't.
//
// Before running: have any project open in Resolve (it is left as it is),
// install the bridge (node tools/install-bridge.ts), start Workspace >
// Scripts > ResolveCollab, close any companion, and have the test media
// (node tools/feasibility/prepare.ts). Then:
//   node tools/m9-resolve-check.ts
//
// It checks: the media folder asked once; the host makes a proxy and sends
// it; it stands in for the clip in Resolve (the session's name and tag) and
// the clip's timeline item comes too; the original on request replaces it,
// the tag put back and the item kept.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const check = (what: string, ok: boolean) => {
  if (!ok) failures++;
  say(`${ok ? "ok  " : "FAIL"}  ${what}`);
};

const CLIP = "camera.mp4";
if (!existsSync(join(SOURCE_MEDIA, CLIP))) throw new Error(`missing ${CLIP}: run node tools/feasibility/prepare.ts first`);
const dir = mkdtempSync(join(tmpdir(), "rc-m9check-"));
const media = join(dir, "host-media");
mkdirSync(media);
mkdirSync(join(dir, "inbox"));
copyFileSync(join(SOURCE_MEDIA, CLIP), join(media, CLIP));
writeFileSync(join(dir, "ResolveDebug.txt"), "");
const testnet = await createTestnet(3);

// --- host: fake bridge, the clip and a timeline using frames 24–119 of it --------
const hostFake = new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox"));
hostFake.project = { id: "m9-host-project", name: "RC M9 Host" };
const clip = hostFake.importClip(join(media, CLIP));
hostFake.timelines.addClip(hostFake.timelines.addTimeline("RC M9 Edit"), clip.id, CLIP, 0, 96);
hostFake.start();
const code = newInviteCode();
const hostBridge = new BridgeClient({ logPath: join(dir, "ResolveDebug.txt"), inboxDir: join(dir, "inbox"), pollMs: 20 });
const hostPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: Buffer.alloc(32, 11) });
const host = new Session({
  role: "host", bridge: hostBridge, peers: hostPeers, storeDir: join(dir, "host-store"), backupsDir: join(dir, "backups"), name: "Fake host",
  approve: async () => "yes", ask: async () => new Map(), confirm: async () => true, fingerprint,
  findFile: (file, dirs) => findFile(file, [...dirs, media]), proxiesDir: join(dir, "host-proxies"),
  log: (m) => say(`host    ${m}`),
});
hostBridge.start();
await hostPeers.start();

// --- member: real Resolve, which doesn't have the clip ---------------------------
const folder = join(dir, "Downloaded");
const memberLogs: string[] = [];
const memberBridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
const memberPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: Buffer.alloc(32, 13) });
const member = new Session({
  role: "member", bridge: memberBridge, peers: memberPeers, storeDir: join(dir, "member-store"), backupsDir: join(homedir(), "ResolveCollab", "backups"),
  name: "Resolve", ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])), confirm: async () => true,
  fingerprint, findFile: (file, dirs) => findFile(file, dirs), proxiesDir: join(dir, "member-proxies"),
  log: (m) => { memberLogs.push(m); say(`member  ${m}`); }, bridgeBuild: localBridgeBuild(),
});
memberBridge.start();
await memberPeers.start();

const resolveClip = () => [...(member.sync?.local.clips.values() ?? [])].find((c) => c.name === CLIP);
const resolveItems = () => [...(member.timelines?.items.values() ?? [])].filter((i) => i.name === CLIP && i.trackKind === "video");

say("M9 check: Resolve is a member of a session whose host has a clip Resolve doesn't");
await waitFor("bridge connected", () => memberBridge.connected, 120_000);
await waitFor("Resolve joined; the clip is missing there", () => member.sync?.paused === false && member.sync.missing.size === 1, 90_000);

say("STEP 1  the media folder is asked once");
await waitFor("asked where media goes", () => member.media?.ask?.kind === "folder", 30_000);
member.media!.useFolder(folder);

say("STEP 2  the host makes a proxy and sends it; it stands in for the clip");
await waitFor("a proxy stands in for the clip in Resolve", () => resolveClip()?.path === join(folder, "camera (proxy).mp4"), 120_000);
const id = Object.values(member.sync!.sessionClips()).find((c) => c.name === CLIP)!.id;
check(`the stand-in has the session's tag (${resolveClip()?.rcId})`, resolveClip()?.rcId === id);
await waitFor("the clip's timeline item came too", () => resolveItems().length === 1, 60_000);
const before = resolveItems()[0];
say(`        item: start ${before?.start}, duration ${before?.duration}, source ${JSON.stringify((before as { srcStart?: number } | undefined)?.srcStart)}`);
say("        In Resolve: open the timeline RC M9 Edit and look: the clip plays (the proxy). Nothing to do; this goes on by itself.");

say("STEP 3  the original on request replaces it");
member.media!.original(id);
await waitFor("Resolve's clip now plays the original", () => resolveClip()?.path === join(folder, CLIP), 120_000);
check("the original is the host's file, byte for byte", readFileSync(join(folder, CLIP)).equals(readFileSync(join(media, CLIP))));
await waitFor("its tag was put back", () => resolveClip()?.rcId === id, 20_000);
check("no stand-ins left", member.media!.standIns === 0);
const after = resolveItems()[0];
check(`the timeline item is the same (start ${after?.start}, duration ${after?.duration})`, resolveItems().length === 1 && after?.start === before?.start && after?.duration === before?.duration);
await new Promise((r) => setTimeout(r, 3000));
check("still one clip and one item after the next pass", [...member.sync!.local.clips.values()].filter((c) => c.name === CLIP).length === 1 && resolveItems().length === 1);

const errors = memberLogs.filter((l) => /error|failed|couldn't|NOT/i.test(l));
if (errors.length) say(`log lines to look at:\n  ${errors.join("\n  ")}`);
say(failures ? `${failures} check(s) FAILED` : "all checks passed");
say(`Resolve now has the project "${member.record?.projectName}" open; the project open before is unchanged.`);
await member.close();
memberBridge.stop();
await memberPeers.stop();
await host.close();
hostBridge.stop();
await hostPeers.stop();
hostFake.stop();
await testnet.destroy();
process.exit(failures ? 1 : 0);
