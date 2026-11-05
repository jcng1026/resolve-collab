// Two companions, each with a fake media pool bridge, over a local DHT
// testnet (SPEC §19.7): live edits both ways, missing media, and an offline
// edit merged with an answer to the conflict question.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { findFile, fingerprint } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { Session } from "./session.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const pcs: Pc[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      const logs = pcs.map((pc) => `--- ${pc.name}\n${pc.logs.join("\n")}`).join("\n");
      throw new Error(`timed out waiting for ${what}\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Pc {
  name: string;
  dir: string;
  media: string;
  fake: FakeBridge;
  bridge?: BridgeClient;
  peers?: PeerLink;
  session?: Session;
  logs: string[];
  questions: Conflict[][];
  answer: Answer;
  delay: number; // ms each received message is held (a slow network)
  confirms: string[]; // yes/no questions asked (answered yes)
}

function makePc(name: string): Pc {
  const dir = mkdtempSync(join(tmpdir(), `rc-${name}-`));
  const media = join(dir, "media");
  mkdirSync(media);
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "ResolveDebug.txt"), "");
  const pc: Pc = { name, dir, media, fake: new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox")), logs: [], questions: [], answer: "mine", delay: 0, confirms: [] };
  pcs.push(pc);
  return pc;
}

// keepBridge: the bridge in Resolve keeps running while the companion restarts.
async function connect(pc: Pc, role: "host" | "member", code: string, keepBridge = false): Promise<void> {
  pc.bridge = new BridgeClient({ logPath: join(pc.dir, "ResolveDebug.txt"), inboxDir: join(pc.dir, "inbox"), pollMs: 20 });
  pc.peers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: createHash("sha256").update(pc.dir).digest(), delay: () => pc.delay });
  pc.session = new Session({
    role, bridge: pc.bridge, peers: pc.peers, storeDir: join(pc.dir, "store"), backupsDir: join(pc.dir, "backups"),
    name: pc.name, approve: async () => "yes", ...(role === "host" && keepBridge ? { resume: true } : {}),
    confirm: async (q) => { pc.confirms.push(q); return true; },
    ask: async (conflicts) => {
      pc.questions.push(conflicts);
      return new Map(conflicts.map((c) => [c.key, pc.answer]));
    },
    fingerprint,
    findFile: (file, dirs) => findFile(file, [...dirs, pc.media]),
    log: (m) => pc.logs.push(m),
  });
  pc.bridge.start();
  if (!keepBridge) pc.fake.start();
  await pc.peers.start();
}

async function disconnect(pc: Pc, keepBridge = false): Promise<void> {
  pc.session!.stop();
  pc.bridge!.stop();
  if (!keepBridge) pc.fake.stop();
  await pc.peers!.stop();
}

// The same file content on both PCs, in different folders.
function mediaFile(pcs: Pc[], name: string, content: string): void {
  for (const pc of pcs) writeFileSync(join(pc.media, name), content);
}

describe("media pool sync between two companions", () => {
  const host = makePc("host");
  const member = makePc("member");
  const code = newInviteCode();

  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    for (const pc of [host, member]) if (pc.peers) await disconnect(pc).catch(() => {});
    await testnet.destroy();
  });

  it("brings the host's media pool to a joining member, finding files by fingerprint", async () => {
    mediaFile([host, member], "a.mp4", "AAAA".repeat(1000));
    const footage = host.fake.addBin("Footage");
    host.fake.importClip(join(host.media, "a.mp4"), footage.id).color = "Orange";
    await connect(host, "host", code);
    await connect(member, "member", code);

    await waitFor("a.mp4 on the member", () => member.fake.clipByName("a.mp4")?.color === "Orange");
    const clip = member.fake.clipByName("a.mp4")!;
    expect(member.fake.bins.get(clip.bin)!.name).toBe("Footage");
    expect(clip.path).toBe(join(member.media, "a.mp4"));
    expect(clip.rcId).toBe(host.fake.clipByName("a.mp4")!.rcId);
  }, 30_000);

  it("syncs live edits both ways, including an emulated bin rename", async () => {
    member.fake.clipByName("a.mp4")!.meta.Scene = "12";
    await waitFor("meta on host", () => host.fake.clipByName("a.mp4")?.meta.Scene === "12");

    host.fake.binByName("Footage")!.name = "Day 1";
    await waitFor("bin rename on member", () => !!member.fake.binByName("Day 1"));
    expect(member.fake.binByName("Footage")).toBeUndefined();
    expect(member.fake.bins.get(member.fake.clipByName("a.mp4")!.bin)!.name).toBe("Day 1");

    const extras = member.fake.addBin("Extras");
    await waitFor("new bin on host", () => !!host.fake.binByName("Extras"));
    member.fake.clipByName("a.mp4")!.bin = extras.id;
    await waitFor("clip moved on host", () => host.fake.bins.get(host.fake.clipByName("a.mp4")!.bin)?.name === "Extras");
  }, 30_000);

  it("a race on one property: the first to reach the host wins, and the other PC is told (SPEC §23.1)", async () => {
    // The member's messages arrive 300 ms late. The host recolours and commits
    // it; the member recolours before it has heard, so its change is based on
    // the older state and reaches the host second.
    member.delay = 300;
    const hostLog = (host.session as unknown as { host: { seq: number } }).host;
    const seen = { host: host.logs.length, member: member.logs.length };
    const before = hostLog.seq;
    host.fake.clipByName("a.mp4")!.color = "Blue";
    await waitFor("the host's change committed", () => hostLog.seq > before);
    member.fake.clipByName("a.mp4")!.color = "Pink";
    const told = (pc: Pc, from: number) => pc.logs.slice(from).some((l) => l.includes("at the same moment"));
    await waitFor("the member told", () => told(member, seen.member));
    await waitFor("both show the host's colour", () => host.fake.clipByName("a.mp4")?.color === "Blue" && member.fake.clipByName("a.mp4")?.color === "Blue");
    expect(told(host, seen.host)).toBe(false);
    await sleep(800); // and it stays that way
    expect(host.fake.clipByName("a.mp4")?.color).toBe("Blue");
    expect(member.fake.clipByName("a.mp4")?.color).toBe("Blue");
    member.delay = 0;

    // The notice names who got there first, and reapply sends it again: now
    // made after seeing the host's change, so it goes through.
    const notice = member.logs.slice(seen.member).find((l) => l.includes("at the same moment"))!;
    expect(notice).toMatch(/^\[(\d+)\] host changed the colour of "a\.mp4" at the same moment, so your change was undone\.  reapply \1 = send yours again$/);
    const n = Number(/^\[(\d+)\]/.exec(notice)![1]);
    expect(member.session!.reapply(n)).toBe("sent again (1 change)");
    await waitFor("Pink everywhere", () => host.fake.clipByName("a.mp4")?.color === "Pink" && member.fake.clipByName("a.mp4")?.color === "Pink");
    expect(member.session!.reapply(n)).toMatch(/no notice/); // once only
  }, 30_000);

  it("undoes and redoes only this PC's own changes, asking when someone changed it since (SPEC §23.2)", async () => {
    const clip = () => [host.fake.clipByName("a.mp4")!, member.fake.clipByName("a.mp4")!];
    const both = (f: (c: ReturnType<typeof clip>[0]) => boolean) => clip().every(f);
    await waitFor("in step", () => both((c) => c.color === "Pink"));
    // The member makes two changes of its own; the host one of its own.
    member.fake.clipByName("a.mp4")!.meta.Take = "7";
    await waitFor("take", () => both((c) => c.meta.Take === "7"));
    member.fake.clipByName("a.mp4")!.name = "renamed.mp4";
    await waitFor("rename", () => !!host.fake.clipByName("renamed.mp4") && !!member.fake.clipByName("renamed.mp4"));
    const byName = (pc: Pc) => pc.fake.clipByName("renamed.mp4") ?? pc.fake.clipByName("a.mp4");
    host.fake.clipByName("renamed.mp4")!.flags = ["Red"];
    await waitFor("flag", () => byName(member)?.flags.includes("Red") === true);

    // Undo: the member's last change (the rename), not the host's flag.
    expect(await member.session!.undo()).toBe("undid your last change");
    await waitFor("rename undone", () => !!host.fake.clipByName("a.mp4") && !!member.fake.clipByName("a.mp4"));
    expect(host.fake.clipByName("a.mp4")!.flags).toEqual(["Red"]);
    // Redo brings it back; undo twice takes both back, in order.
    expect(await member.session!.redo()).toBe("redid your last undone change");
    await waitFor("rename redone", () => !!host.fake.clipByName("renamed.mp4") && !!member.fake.clipByName("renamed.mp4"));
    await member.session!.undo();
    await waitFor("rename undone again", () => !!host.fake.clipByName("a.mp4"));
    expect(member.confirms).toEqual([]);
    // Someone else changes the Take since: undoing asks first.
    host.fake.clipByName("a.mp4")!.meta.Take = "9";
    await waitFor("host's take", () => member.fake.clipByName("a.mp4")?.meta.Take === "9");
    expect(await member.session!.undo()).toBe("undid your last change");
    expect(member.confirms).toEqual(['host has since changed the Take of "a.mp4". Undo anyway?']);
    await waitFor("take unset", () => both((c) => c.meta.Take === undefined));
    expect(await member.session!.undo()).not.toBe("nothing of yours to undo"); // the earlier colour race step
  }, 40_000);

  it("lists media the member lacks, and imports it once located", async () => {
    writeFileSync(join(host.media, "b.mp4"), "BBBB".repeat(1000));
    host.fake.importClip(join(host.media, "b.mp4"));
    await waitFor("missing notice", () => member.logs.some((l) => l.includes('missing media: "b.mp4"')));
    expect(member.fake.clipByName("b.mp4")).toBeUndefined();

    const elsewhere = join(member.dir, "found-b.mp4");
    writeFileSync(elsewhere, "BBBB".repeat(1000));
    const [missing] = member.session!.sync.missing.values();
    const id = missing!.id.slice(0, 8);
    expect(await member.session!.sync.locate(id, join(member.dir, "nowhere.mp4"))).toMatch(/can't read/);
    writeFileSync(join(member.dir, "other.mp4"), "CCCC".repeat(1000)); // same size, other content
    expect(await member.session!.sync.locate(id, join(member.dir, "other.mp4"))).toMatch(/not the same file/);
    expect(await member.session!.sync.locate(id, elsewhere)).toMatch(/imported/);
    await waitFor("b.mp4 on member", () => !!member.fake.clipByName("found-b.mp4") || !!member.fake.clipByName("b.mp4"));
    expect(member.fake.clipByName("b.mp4")?.rcId ?? member.fake.clipByName("found-b.mp4")?.rcId).toBe(host.fake.clipByName("b.mp4")!.rcId);
  }, 30_000);

  it("deletes live", async () => {
    host.fake.poolClips.delete(host.fake.clipByName("b.mp4")!.id);
    await waitFor("b.mp4 gone on member", () => !member.fake.clipByName("b.mp4"));
  }, 30_000);

  it("merges offline edits: different fields automatically, the same field by asking", async () => {
    await disconnect(member, true);
    const memberClip = member.fake.clipByName("a.mp4")!;
    memberClip.name = "a (member).mp4";
    memberClip.color = "Blue";
    host.fake.clipByName("a.mp4")!.name = "a (host).mp4";
    host.fake.clipByName("a (host).mp4")!.meta.Take = "3";
    await new Promise((r) => setTimeout(r, 300)); // host's edit reaches its session

    member.answer = "mine";
    await connect(member, "member", code, true);
    await waitFor("question asked", () => member.questions.length > 0);
    expect(member.questions[0]).toEqual([expect.objectContaining({ kind: "field", field: "name", mine: "a (member).mp4", theirs: "a (host).mp4" })]);
    await waitFor("member's name on host", () => !!host.fake.clipByName("a (member).mp4"));
    const onHost = host.fake.clipByName("a (member).mp4")!;
    expect(onHost.color).toBe("Blue");
    expect(onHost.meta).toEqual({ Scene: "12", Take: "3" });
    await waitFor("host's meta on member", () => member.fake.clipByName("a (member).mp4")?.meta.Take === "3");
    expect(member.logs.some((l) => l.startsWith("backup saved"))).toBe(true);
    expect(host.questions).toEqual([]); // only the returning person is asked

    // The host's name was replaced by the member's Keep mine: the host is told,
    // and restore puts it back as a new edit (SPEC §23.3).
    await waitFor("host told", () => host.logs.some((l) => l.includes("offline changes replaced your")));
    const notice = host.logs.find((l) => l.includes("offline changes replaced your"))!;
    expect(notice).toMatch(/^\[(\d+)\] member's offline changes replaced your name on "a \(member\)\.mp4"\.  restore \d+ = put yours back$/);
    expect(member.logs.some((l) => l.includes("offline changes replaced your"))).toBe(false);
    const n = Number(/^\[(\d+)\]/.exec(notice)![1]);
    expect(host.session!.restore(n)).toBe("put yours back (1 change)");
    await waitFor("host's name back on both", () => !!host.fake.clipByName("a (host).mp4") && !!member.fake.clipByName("a (host).mp4"));
    expect(host.fake.clipByName("a (host).mp4")!.color).toBe("Blue"); // only the name went back
  }, 40_000);

  it("resumes after the host's companion restarts, with the member still connected", async () => {
    await disconnect(host, true);
    await waitFor("member notices", () => member.logs.some((l) => l.startsWith("Offline: the host is unreachable")));
    await connect(host, "host", code, true);
    await waitFor("member rejoins", () => member.logs.filter((l) => /^(re)?joined the session/.test(l)).length >= 3);
    member.fake.clipByName("a (host).mp4")!.meta.Scene = "13";
    await waitFor("edit reaches the restarted host", () => host.fake.clipByName("a (host).mp4")?.meta.Scene === "13");
    expect(host.fake.poolClips.size).toBe(member.fake.poolClips.size);
  }, 40_000);
});
