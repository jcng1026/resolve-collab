// Two companions, each with a fake bridge, syncing markers over a local DHT
// testnet (SPEC §21.6): timeline, item and media pool clip markers both
// ways, a moved and recoloured marker, a timeline that isn't open, a
// duplicated timeline, the pool clip's markers Resolve copies onto new items,
// and an offline merge.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import type { FakeItem, FakeMarker, FakeTimeline } from "./bridge/fake-timelines.ts";
import { findFile, fingerprint } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { Session } from "./session.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";
import type { SessionModel } from "./sync/session-model.ts";

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const all: Pc[] = [];

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
  forceTier?: 2;
}

async function waitFor(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      const logs = all.map((pc) => `--- ${pc.name}\n${pc.logs.join("\n")}`).join("\n");
      throw new Error(`timed out waiting for ${what}\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makePc(name: string, forceTier?: 2): Pc {
  const dir = mkdtempSync(join(tmpdir(), `rc-mk-${name}-`));
  const media = join(dir, "media");
  mkdirSync(media);
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "ResolveDebug.txt"), "");
  const pc: Pc = { name, dir, media, fake: new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox")), logs: [], questions: [], ...(forceTier ? { forceTier } : {}) };
  all.push(pc);
  return pc;
}

// keepBridge: the bridge in Resolve keeps running while the companion restarts.
async function connect(pc: Pc, role: "host" | "member", code: string, keepBridge = false, answer: Answer = "mine"): Promise<void> {
  pc.bridge = new BridgeClient({ logPath: join(pc.dir, "ResolveDebug.txt"), inboxDir: join(pc.dir, "inbox"), pollMs: 20 });
  pc.peers = new PeerLink(code, { bootstrap: testnet.bootstrap });
  pc.session = new Session({
    role, bridge: pc.bridge, peers: pc.peers, storeDir: join(pc.dir, "store"), backupsDir: join(pc.dir, "backups"),
    confirm: async () => true,
    ask: async (conflicts) => {
      pc.questions.push(conflicts);
      return new Map(conflicts.map((c) => [c.key, answer]));
    },
    fingerprint,
    findFile: (file, dirs) => findFile(file, [...dirs, pc.media]),
    log: (m) => pc.logs.push(m),
    ...(pc.forceTier ? { forceTier: pc.forceTier } : {}),
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

function footage(host: Pc, others: Pc[], name: string): string {
  for (const pc of [host, ...others]) writeFileSync(join(pc.media, name), `${name}`.repeat(500));
  return host.fake.importClip(join(host.media, name)).id;
}

const tl = (pc: Pc, name = "Edit"): FakeTimeline | undefined => pc.fake.timelines.timelineByName(name);
const clip = (pc: Pc, name: string, timeline = "Edit"): FakeItem | undefined => {
  const t = tl(pc, timeline);
  return t && pc.fake.timelines.itemByName(t, name, "video");
};
const marker = (frame: number, extra: Partial<FakeMarker> = {}): FakeMarker => ({ frame, duration: 1, color: "Blue", name: `at ${frame}`, note: "", tag: "", ...extra });
const names = (markers: FakeMarker[] | undefined) => (markers ?? []).map((m) => `${m.frame}:${m.color}:${m.name}`).sort();
// The host's session model (private to Session).
const hostModel = (pc: Pc) => (pc.session as unknown as { host: { model: SessionModel } }).host.model;
const isTag = (tag: string) => /^rc:[0-9a-f]{32}$/.test(tag);

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  for (const pc of all) if (pc.peers) await disconnect(pc).catch(() => {});
  await testnet.destroy();
});

describe("marker sync between two companions", () => {
  const host = makePc("host");
  const member = makePc("member");
  const code = newInviteCode();

  it("brings timeline and item markers to a joining member, and tags them", async () => {
    const media = footage(host, [member], "a.mp4");
    const edit = host.fake.timelines.addTimeline("Edit");
    edit.markers.push(marker(10, { note: "naïve 🎬\nsecond line" }), marker(100, { duration: 48, color: "Yellow" }));
    host.fake.timelines.addClip(edit, media, "a.mp4", 0, 240).markers.push(marker(5, { color: "Red" }));
    await connect(host, "host", code);
    await connect(member, "member", code);

    await waitFor("markers on the member", () => tl(member)?.markers.length === 2 && clip(member, "a.mp4")?.markers.length === 1);
    expect(names(tl(member)!.markers)).toEqual(["100:Yellow:at 100", "10:Blue:at 10"]);
    expect(tl(member)!.markers.find((m) => m.frame === 10)!.note).toBe("naïve 🎬\nsecond line");
    expect(tl(member)!.markers.find((m) => m.frame === 100)!.duration).toBe(48);
    expect(names(clip(member, "a.mp4")!.markers)).toEqual(["5:Red:at 5"]);
    // The host's markers got their hidden IDs, the same ones the member's carry.
    await waitFor("host's markers tagged", () => tl(host)!.markers.every((m) => isTag(m.tag)) && clip(host, "a.mp4")!.markers.every((m) => isTag(m.tag)));
    expect(tl(member)!.markers.map((m) => m.tag).sort()).toEqual(tl(host)!.markers.map((m) => m.tag).sort());
  }, 30_000);

  it("syncs a moved and recoloured marker as the same marker, both ways", async () => {
    const m = tl(member)!.markers.find((x) => x.frame === 10)!;
    const tag = m.tag;
    Object.assign(m, { frame: 30, color: "Red", name: "moved" });
    await waitFor("moved on host", () => tl(host)!.markers.some((x) => x.frame === 30 && x.color === "Red" && x.name === "moved"));
    expect(tl(host)!.markers.find((x) => x.frame === 30)!.tag).toBe(tag);
    expect(tl(host)!.markers).toHaveLength(2);
    const onClip = clip(host, "a.mp4")!.markers[0]!;
    onClip.note = "from the host";
    await waitFor("item marker note on member", () => clip(member, "a.mp4")?.markers[0]?.note === "from the host");
  }, 30_000);

  it("adds and deletes markers both ways", async () => {
    clip(member, "a.mp4")!.markers.push(marker(60, { color: "Green" }));
    tl(host)!.markers.splice(tl(host)!.markers.findIndex((x) => x.frame === 100), 1);
    await waitFor("item marker on host", () => clip(host, "a.mp4")!.markers.length === 2);
    await waitFor("timeline marker gone on member", () => tl(member)!.markers.length === 1);
    clip(host, "a.mp4")!.markers = clip(host, "a.mp4")!.markers.filter((x) => x.frame !== 60);
    await waitFor("item marker gone on member", () => clip(member, "a.mp4")!.markers.length === 1);
  }, 30_000);

  it("syncs media pool clip markers, and copies made when a clip is added only once", async () => {
    const pool = host.fake.clipByName("a.mp4")!;
    pool.markers.push(marker(50, { color: "Cyan", name: "pool" }));
    await waitFor("pool marker on member", () => member.fake.clipByName("a.mp4")?.markers.length === 1);
    await waitFor("host's pool marker tagged", () => pool.markers[0]!.tag.startsWith("rc:p:"));
    expect(member.fake.clipByName("a.mp4")!.markers[0]!.tag).toBe(pool.markers[0]!.tag);

    // The host adds the clip again: Resolve copies the pool marker onto it.
    const again = host.fake.timelines.addClip(tl(host)!, pool.id, "a.mp4", 600, 48);
    expect(names(again.markers)).toEqual(["50:Cyan:pool"]);
    const onMember = () => [...tl(member)!.items.values()].find((i) => i.trackKind === "video" && i.start === 600);
    await waitFor("second use on member", () => !!onMember());
    await waitFor("its copied marker on member", () => onMember()!.markers.length === 1);
    await sleep(500);
    // One copy, not the member's own copy plus the host's: the companion's
    // add starts the item without Resolve's copies.
    expect(names(onMember()!.markers)).toEqual(["50:Cyan:pool"]);
    expect(isTag(onMember()!.markers[0]!.tag)).toBe(true); // an item marker of its own, not the pool marker
    expect(names(member.fake.clipByName("a.mp4")!.markers)).toEqual(["50:Cyan:pool"]);
    expect(Object.keys(hostModel(host).pool.markers)).toHaveLength(1);
  }, 30_000);

  it("waits with markers on a timeline that isn't open until it's opened", async () => {
    const second = member.fake.timelines.addTimeline("Second", false);
    second.markers.push(marker(7, { color: "Lemon" }));
    member.fake.timelines.current = second.id;
    await waitFor("Second on host", () => !!tl(host, "Second"));
    await sleep(500);
    expect(tl(host, "Second")!.markers).toEqual([]);
    host.fake.timelines.current = tl(host, "Second")!.id;
    await waitFor("marker on host's Second", () => tl(host, "Second")!.markers.length === 1);
    host.fake.timelines.current = tl(host)!.id;
    member.fake.timelines.current = tl(member)!.id;
  }, 30_000);

  it("gives a duplicated timeline's markers IDs of their own", async () => {
    const original = tl(host)!;
    const tags = (t: FakeTimeline) => [...t.markers, ...[...t.items.values()].flatMap((i) => i.markers)].map((m) => m.tag);
    const before = tags(original);
    const copy = host.fake.timelines.duplicateTimeline(original, "Edit copy");
    host.fake.timelines.current = copy.id;
    await waitFor("copy tagged anew", () => tags(copy).every((t) => isTag(t) && !before.includes(t)));
    host.fake.timelines.current = original.id;
    await sleep(300);
    expect(tags(original)).toEqual(before);
    // The copy's timeline marker, a.mp4's marker, and the pool marker's copies
    // on the second use's video and audio, as markers of their own.
    const copyId = Object.values(hostModel(host).timelines.timelines).find((t) => t.name === "Edit copy")!.id;
    expect(Object.values(hostModel(host).timelines.markers).filter((m) => m.timeline === copyId)).toHaveLength(4);
  }, 30_000);

  it("merges offline marker edits: different fields automatically", async () => {
    await disconnect(member, true);
    tl(member)!.markers[0]!.color = "Purple";
    tl(host)!.markers[0]!.note = "host's note";
    await sleep(500);
    await connect(member, "member", code, true);
    await waitFor("both edits on both", () => [host, member].every((pc) => tl(pc)!.markers[0]?.color === "Purple" && tl(pc)!.markers[0]?.note === "host's note"));
    expect(member.questions).toEqual([]);
  }, 40_000);

  it("asks the returning person once about two markers on one frame, and keeps theirs or mine for everyone", async () => {
    await disconnect(member, true);
    tl(member)!.markers.push(marker(200, { name: "member's", color: "Green" }));
    tl(host)!.markers.push(marker(200, { name: "host's", color: "Red" }));
    await sleep(500);
    member.questions.length = 0;
    await connect(member, "member", code, true); // answers "mine"
    await waitFor("member asked", () => member.questions.length > 0);
    expect(member.questions[0]).toEqual([expect.objectContaining({ kind: "clash", item: "marker", label: "member's" })]);
    await waitFor("the member's marker on both", () =>
      [host, member].every((pc) => tl(pc)!.markers.filter((m) => m.frame === 200).map((m) => m.name).join() === "member's"));
    expect(host.questions).toEqual([]);
    expect([host, member].flatMap((pc) => pc.logs.filter((l) => l.includes("couldn't be placed")).map((l) => `${pc.name}: ${l}`))).toEqual([]);
  }, 40_000);
});

describe("markers of a rebuilt item", () => {
  it("are put back on the rebuilt item, not deleted for everyone", async () => {
    const host = makePc("t2host");
    const member = makePc("t2member", 2); // tier 2: a move is a rebuild
    const code = newInviteCode();
    const media = footage(host, [member], "r.mp4");
    const edit = host.fake.timelines.addTimeline("Edit");
    host.fake.timelines.addClip(edit, media, "r.mp4", 0, 48).markers.push(marker(5, { color: "Rose" }));
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("marker on member", () => clip(member, "r.mp4")?.markers.length === 1);
    const before = clip(member, "r.mp4")!.id;
    clip(host, "r.mp4")!.start = 96;
    await waitFor("rebuilt on member", () => clip(member, "r.mp4")?.start === 96 && clip(member, "r.mp4")!.id !== before);
    await waitFor("marker back on member", () => clip(member, "r.mp4")!.markers.length === 1);
    await sleep(500);
    expect(names(clip(host, "r.mp4")!.markers)).toEqual(["5:Rose:at 5"]);
    expect(Object.keys(hostModel(host).timelines.markers)).toHaveLength(1);
  }, 30_000);
});
