// One-PC check of M7 in real Resolve (SPEC §23.4). Resolve is a MEMBER of a
// session hosted by an in-process fake host, over a local DHT testnet.
//
// Before running: have any project open in Resolve (it is left as it is),
// install the bridge (node tools/install-bridge.ts) and start Workspace >
// Scripts > ResolveCollab. Close any companion. Then:
//   node tools/m7-resolve-check.ts
// and do the "In Resolve:" steps it prints (each waits for you).
//
// It checks: a race on a clip's colour (Resolve's change reaches the host
// second, so it's undone with a notice), reapply; undo and redo of Resolve's
// own change, asking first when the host changed it since; the page in the
// heartbeat; Ctrl+Z claimed on the Edit page and left to Resolve on Color.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { localBridgeBuild } from "../src/bridge/bridge-build.ts";
import { BridgeClient } from "../src/bridge/bridge-client.ts";
import { FakeBridge } from "../src/bridge/fake-bridge.ts";
import { UndoKeys } from "../src/bridge/undo-keys.ts";
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

const CLIP = "original.mp4";
if (!existsSync(join(SOURCE_MEDIA, CLIP))) throw new Error(`missing ${CLIP}: run node tools/feasibility/prepare.ts first`);
const dir = mkdtempSync(join(tmpdir(), "rc-m7check-"));
const media = join(dir, "media");
mkdirSync(media);
mkdirSync(join(dir, "inbox"));
copyFileSync(join(SOURCE_MEDIA, CLIP), join(media, CLIP));
writeFileSync(join(dir, "ResolveDebug.txt"), "");
const testnet = await createTestnet(3);

// --- host: fake bridge, with a clip and a timeline -------------------------------
const hostFake = new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox"));
hostFake.project = { id: "m7-host-project", name: "RC M7 Host" };
const clip = hostFake.importClip(join(media, CLIP));
hostFake.timelines.addClip(hostFake.timelines.addTimeline("RC M7 Edit"), clip.id, CLIP, 0, 48);
hostFake.start();
const hostLogs: string[] = [];
const code = newInviteCode();
const hostBridge = new BridgeClient({ logPath: join(dir, "ResolveDebug.txt"), inboxDir: join(dir, "inbox"), pollMs: 20 });
const hostPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: Buffer.alloc(32, 7) });
const host = new Session({
  role: "host", bridge: hostBridge, peers: hostPeers, storeDir: join(dir, "host-store"), backupsDir: join(dir, "backups"), name: "Fake host",
  approve: async () => "yes", ask: async () => new Map(), confirm: async () => true, fingerprint,
  findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { hostLogs.push(m); say(`host    ${m}`); },
});
hostBridge.start();
await hostPeers.start();

// --- member: real Resolve, with a slow network on demand -------------------------
const memberLogs: string[] = [];
const questions: string[] = [];
let delay = 0;
const memberBridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: DEFAULT_INBOX });
const memberPeers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: Buffer.alloc(32, 9), delay: () => delay });
const member = new Session({
  role: "member", bridge: memberBridge, peers: memberPeers, storeDir: join(dir, "member-store"), backupsDir: join(homedir(), "ResolveCollab", "backups"),
  name: "Resolve", ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])),
  confirm: async (q) => { questions.push(q); say(`member  asked: ${q}  -> yes`); return true; },
  fingerprint, findFile: (file, dirs) => findFile(file, [...dirs, media]),
  log: (m) => { memberLogs.push(m); say(`member  ${m}`); }, bridgeBuild: localBridgeBuild(),
});
memberBridge.start();
await memberPeers.start();

// Ctrl+Z as the companion wires it (src/companion.ts).
const keys = new UndoKeys();
const keyEvents: string[] = [];
const UNDO_PAGES = new Set(["media", "cut", "edit"]);
const allowKeys = () => keys.allow(member.begun && UNDO_PAGES.has(memberBridge.page ?? ""));
memberBridge.on("page", (p: string) => { say(`member  page: ${p}`); allowKeys(); });
const keysTimer = setInterval(allowKeys, 500);
for (const e of ["armed", "released", "taken"]) keys.on(e, () => { keyEvents.push(e); say(`keys    ${e}`); });
keys.on("undo", () => { keyEvents.push("undo"); void member.undo().then((r) => say(`member  Ctrl+Z: ${r}`)); });
keys.on("redo", () => { keyEvents.push("redo"); void member.redo().then((r) => say(`member  Ctrl+Shift+Z: ${r}`)); });
keys.start();

const resolveColor = () => [...(member.sync?.local.clips.values() ?? [])].find((c) => c.name === CLIP)?.color;
const both = (color: string) => resolveColor() === color && clip.color === color;
// The colour in the host's session (its log's model).
const hostColor = () => Object.values((host as unknown as { host: { model: { pool: { clips: Record<string, { name: string; color: string }> } } } })
  .host.model.pool.clips).find((c) => c.name === CLIP)?.color;

say("M7 check: Resolve is a member of a session hosted by a fake PC");
await waitFor("bridge connected", () => memberBridge.connected, 120_000);
await waitFor("Resolve joined and has the host's clip", () => member.sync?.paused === false && resolveColor() !== undefined, 90_000);
await waitFor("the page is in the heartbeat", () => memberBridge.page === "edit" || memberBridge.page === "media" || memberBridge.page === "cut", 10_000);

say("STEP 1  a race: the host recolours first; Resolve's messages are held 25 s, so its change is based on the older state");
delay = 25_000;
clip.color = "Blue";
await waitFor("the host committed Blue", () => hostColor() === "Blue", 10_000);
say(`        In Resolve: in the Media Pool, right-click  ${CLIP}  > Clip Color > Pink  (within 20 s)`);
await waitFor("Resolve's change seen", () => resolveColor() === "Pink", 20_000);
delay = 0;
await waitFor("Resolve told it lost the race", () => memberLogs.some((l) => /^\[\d+\] Fake host changed the colour of "original\.mp4" at the same moment/.test(l)), 40_000);
await waitFor("Resolve shows the host's Blue", () => both("Blue"), 20_000);
const notice = memberLogs.find((l) => l.includes("at the same moment"))!;
const n = Number(/^\[(\d+)\]/.exec(notice)?.[1]);
const reapplied = member.reapply(n);
check(`reapply ${n}: ${reapplied}`, reapplied.startsWith("sent again"));
await waitFor("Pink on both after reapply", () => both("Pink"), 20_000);

say("STEP 2  undo and redo of Resolve's own change (the reapply)");
check(`undo: ${await member.undo()}`, true);
await waitFor("Blue on both after undo", () => both("Blue"), 20_000);
check(`redo: ${await member.redo()}`, true);
await waitFor("Pink on both after redo", () => both("Pink"), 20_000);
clip.color = "Green"; // the host changes it since
await waitFor("Green on both", () => both("Green"), 20_000);
check(`undo after the host's change: ${await member.undo()}`, questions.some((q) => q.startsWith('Fake host has since changed the colour of "original.mp4"')));
await waitFor("Blue on both after that undo", () => both("Blue"), 20_000);
check(`redo again: ${await member.redo()}`, true);
await waitFor("Pink on both", () => both("Pink"), 20_000);

say("STEP 3  Ctrl+Z in Resolve on the Edit page");
say("        In Resolve: click the timeline area (Edit page), then press Ctrl+Z");
await waitFor("the keys are claimed", () => keyEvents.includes("armed"), 60_000);
await waitFor("Ctrl+Z undid Resolve's change (Blue on both)", () => keyEvents.includes("undo") && both("Blue"), 60_000);
say("        In Resolve: press Ctrl+Shift+Z");
await waitFor("Ctrl+Shift+Z redid it (Pink on both)", () => keyEvents.includes("redo") && both("Pink"), 60_000);
say("        In Resolve: go to the Color page");
await waitFor("the page is color, and the keys are given back", () => memberBridge.page === "color" && keyEvents.at(-1) === "released", 60_000);
say("        In Resolve: press Ctrl+Z on the Color page, then go back to the Edit page");
await waitFor("back on the Edit page", () => memberBridge.page === "edit", 60_000);
check("Ctrl+Z on the Color page stayed Resolve's", keyEvents.filter((e) => e === "undo").length === 1 && both("Pink"));

const errors = [...hostLogs, ...memberLogs].filter((l) => /error|failed|couldn't|NOT/i.test(l));
if (errors.length) say(`log lines to look at:\n  ${errors.join("\n  ")}`);
say(failures ? `${failures} check(s) FAILED` : "all checks passed");
say(`Resolve now has the project "${member.record?.projectName}" open; the project open before is unchanged.`);
clearInterval(keysTimer);
keys.stop();
await member.close();
memberBridge.stop();
await memberPeers.stop();
await host.close();
hostBridge.stop();
await hostPeers.stop();
hostFake.stop();
await testnet.destroy();
process.exit(failures ? 1 : 0);
