// Two companions, each with a fake bridge, syncing timelines over a local DHT
// testnet (SPEC §20.8): join, live edits both ways, tracks, Text+, a timeline
// that isn't open, fades Resolve forgets, a middle track delete, and the
// forced tiers 2 and 3.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import type { FakeItem, FakeTimeline } from "./bridge/fake-timelines.ts";
import { findFile, fingerprint } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { Session } from "./session.ts";

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
  forceTier?: 2 | 3;
  busy?: boolean; // the user holds the mouse button
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

function makePc(name: string, forceTier?: 2 | 3): Pc {
  const dir = mkdtempSync(join(tmpdir(), `rc-tl-${name}-`));
  const media = join(dir, "media");
  mkdirSync(media);
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "ResolveDebug.txt"), "");
  const pc: Pc = { name, dir, media, fake: new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox")), logs: [], ...(forceTier ? { forceTier } : {}) };
  all.push(pc);
  return pc;
}

async function connect(pc: Pc, role: "host" | "member", code: string): Promise<void> {
  pc.bridge = new BridgeClient({ logPath: join(pc.dir, "ResolveDebug.txt"), inboxDir: join(pc.dir, "inbox"), pollMs: 20 });
  pc.peers = new PeerLink(code, { bootstrap: testnet.bootstrap });
  pc.session = new Session({
    role, bridge: pc.bridge, peers: pc.peers, storeDir: join(pc.dir, "store"), backupsDir: join(pc.dir, "backups"),
    confirm: async () => true,
    ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "mine"])),
    fingerprint,
    findFile: (file, dirs) => findFile(file, [...dirs, pc.media]),
    log: (m) => pc.logs.push(m),
    ...(pc.forceTier ? { forceTier: pc.forceTier } : {}),
    userBusy: () => !!pc.busy,
  });
  pc.bridge.start();
  pc.fake.start();
  await pc.peers.start();
}

async function disconnect(pc: Pc): Promise<void> {
  pc.session!.stop();
  pc.bridge!.stop();
  pc.fake.stop();
  await pc.peers!.stop();
}

// The same file on both PCs, imported into the host's media pool.
function footage(host: Pc, others: Pc[], name: string): string {
  for (const pc of [host, ...others]) writeFileSync(join(pc.media, name), `${name}`.repeat(500));
  return host.fake.importClip(join(host.media, name)).id;
}

const tl = (pc: Pc, name = "Edit"): FakeTimeline | undefined => pc.fake.timelines.timelineByName(name);
const clip = (pc: Pc, name: string, kind: "video" | "audio" = "video", timeline = "Edit"): FakeItem | undefined => {
  const t = tl(pc, timeline);
  return t && pc.fake.timelines.itemByName(t, name, kind);
};

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  for (const pc of all) if (pc.peers) await disconnect(pc).catch(() => {});
  await testnet.destroy();
});

describe("timeline sync between two companions", () => {
  const host = makePc("host");
  const member = makePc("member");
  const code = newInviteCode();

  it("brings the host's timeline to a joining member, with linked audio", async () => {
    const media = footage(host, [member], "a.mp4");
    const edit = host.fake.timelines.addTimeline("Edit");
    host.fake.timelines.addClip(edit, media, "a.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);

    await waitFor("Edit with a.mp4 on the member", () => !!clip(member, "a.mp4") && !!clip(member, "a.mp4", "audio"));
    const v = clip(member, "a.mp4")!;
    const a = clip(member, "a.mp4", "audio")!;
    expect([v.start, v.duration, v.trackIndex]).toEqual([0, 48, 1]);
    await waitFor("video and audio linked", () => clip(member, "a.mp4")!.linked.includes(a.id));
  }, 30_000);

  it("syncs trims, moves and properties both ways", async () => {
    clip(host, "a.mp4")!.duration = 40;
    await waitFor("trim on member", () => clip(member, "a.mp4")?.duration === 40);
    const m = clip(member, "a.mp4")!;
    m.start = 100;
    m.props = { ...m.props, ZoomX: 1.5 };
    await waitFor("move and zoom on host", () => clip(host, "a.mp4")?.start === 100 && clip(host, "a.mp4")?.props.ZoomX === 1.5);
  }, 30_000);

  it("syncs a new track and a Text+ title with its words", async () => {
    const edit = tl(host)!;
    edit.video.push({ name: "Titles", enabled: true, locked: false, subType: "" });
    host.fake.timelines.addItem(edit, { kind: "textplus", trackKind: "video", trackIndex: 2, start: 200, duration: 72, name: "Text+", template: "Text+",
      text: { styled: "Hello ü", font: "Open Sans", style: "Regular", size: 0.12 } });
    await waitFor("track and title on member", () => tl(member)!.video[1]?.name === "Titles" && !!clip(member, "Text+"));
    expect(clip(member, "Text+")!.text?.styled).toBe("Hello ü");
    expect(clip(member, "Text+")!.duration).toBe(72);
  }, 30_000);

  it("applies changes to a timeline that isn't open when it is opened", async () => {
    const media = footage(host, [member], "b.mp4");
    await waitFor("b.mp4 in the member's pool", () => !!member.fake.clipByName("b.mp4"));
    // The member makes a second timeline; the host stays on Edit.
    const second = member.fake.timelines.addTimeline("Second");
    member.fake.timelines.addClip(second, member.fake.clipByName("b.mp4")!.id, "b.mp4", 24, 48);
    await waitFor("Second exists on host", () => !!tl(host, "Second"));
    await new Promise((r) => setTimeout(r, 300));
    expect(tl(host, "Second")!.items.size).toBe(0); // waiting until opened
    expect(host.logs.some((l) => l.includes('changes to "Second" will be applied when you open it'))).toBe(true);
    host.fake.timelines.current = tl(host, "Second")!.id;
    await waitFor("b.mp4 on host's Second", () => clip(host, "b.mp4", "video", "Second")?.start === 24);
    void media;
    host.fake.timelines.current = tl(host)!.id;
    member.fake.timelines.current = tl(member)!.id;
  }, 30_000);

  it("puts back a fade Resolve forgot when the project was reopened", async () => {
    const m = clip(member, "a.mp4")!;
    m.fadeIn = 12; // made in the member's UI, so it stays there
    await waitFor("fade on host", () => clip(host, "a.mp4")?.fadeIn === 12);
    host.fake.timelines.reopen(); // Resolve on the host forgets the fade
    expect(clip(host, "a.mp4")!.fadeIn).toBe(0);
    await waitFor("fade restored on host", () => clip(host, "a.mp4")?.fadeIn === 12);
    await new Promise((r) => setTimeout(r, 300));
    expect(clip(member, "a.mp4")!.fadeIn).toBe(12); // never proposed as removed
  }, 30_000);

  it("deletes the right track when a middle track is deleted", async () => {
    const edit = tl(host)!;
    edit.video.push({ name: "Top", enabled: true, locked: false, subType: "" });
    host.fake.timelines.addItem(edit, { kind: "generator", trackKind: "video", trackIndex: 3, start: 0, duration: 48, name: "Solid Color", template: "Solid Color" });
    await waitFor("Top track on member", () => tl(member)!.video[2]?.name === "Top" && !!clip(member, "Solid Color"));
    // Delete V2 ("Titles") on the host: Top moves down to V2.
    edit.video.splice(1, 1);
    for (const it of [...edit.items.values()]) {
      if (it.trackKind !== "video") continue;
      if (it.trackIndex === 2) edit.items.delete(it.id);
      else if (it.trackIndex === 3) it.trackIndex = 2;
    }
    await waitFor("member has V1 + Top", () => tl(member)!.video.length === 2);
    expect(tl(member)!.video[1]!.name).toBe("Top");
    expect(clip(member, "Solid Color")!.trackIndex).toBe(2);
    expect(clip(member, "Text+")).toBeUndefined();
  }, 30_000);

  it("never takes opening another project for deleting its timelines", async () => {
    const original = host.fake.project;
    host.fake.switchProject({ id: "other-project", name: "Other" });
    await waitFor("host paused", () => host.logs.some((l) => l.includes("You switched to another project")));
    await new Promise((r) => setTimeout(r, 500));
    expect(tl(member)).toBeDefined();
    expect(member.logs.some((l) => l.includes("a timeline was deleted"))).toBe(false);
    host.fake.switchProject(original);
    await waitFor("host back", () => host.logs.some((l) => l.includes(`Back on "${original.name}"`)));
    clip(host, "a.mp4")!.start = 200;
    await waitFor("edits sync again", () => clip(member, "a.mp4")?.start === 200);
    expect(tl(member, "Second")).toBeDefined();
  }, 30_000);
});

describe("forced tiers", () => {
  it("tier 2 rebuilds the item instead of setting it", async () => {
    const host = makePc("t2host");
    const member = makePc("t2member", 2);
    const code = newInviteCode();
    const media = footage(host, [member], "c.mp4");
    host.fake.timelines.addClip(host.fake.timelines.addTimeline("Edit"), media, "c.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("c.mp4 on member", () => !!clip(member, "c.mp4"));
    const before = clip(member, "c.mp4")!.id;
    clip(host, "c.mp4")!.start = 96;
    await waitFor("moved on member", () => clip(member, "c.mp4")?.start === 96);
    expect(clip(member, "c.mp4")!.id).not.toBe(before); // rebuilt: a new Resolve item
    expect(member.fake.commands.some((c) => c.type === "item.set")).toBe(false);
  }, 30_000);

  it("without forcing, never swaps in another PC's timeline file: a track inserted between others is reported", async () => {
    const host = makePc("noswaphost");
    const member = makePc("noswapmember");
    const code = newInviteCode();
    const media = footage(host, [member], "e.mp4");
    const edit = host.fake.timelines.addTimeline("Edit");
    host.fake.timelines.addClip(edit, media, "e.mp4", 0, 48);
    edit.video.push({ name: "Top", enabled: true, locked: false, subType: "" });
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("Edit with two video tracks on member", () => tl(member)?.video.length === 2 && !!clip(member, "e.mp4"));
    // A track inserted between V1 and Top: Resolve can only add at the end.
    edit.video.splice(1, 0, { name: "Middle", enabled: true, locked: false, subType: "" });
    await waitFor("the member is told", () => member.logs.some((l) => l.includes("a track was inserted between others; this change can't be synced here")));
    expect(member.fake.commands.some((c) => c.type === "tl.swap")).toBe(false);
    expect(member.fake.commands.some((c) => c.type === "tl.export")).toBe(false);
  }, 30_000);

  it("tier 3 swaps in the author's copy of the timeline", async () => {
    const host = makePc("t3host");
    const member = makePc("t3member", 3);
    const code = newInviteCode();
    const media = footage(host, [member], "d.mp4");
    host.fake.timelines.addClip(host.fake.timelines.addTimeline("Edit"), media, "d.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("d.mp4 on member", () => clip(member, "d.mp4")?.start === 0);
    expect(member.fake.commands.some((c) => c.type === "tl.swap")).toBe(true);
    clip(host, "d.mp4")!.start = 120;
    await waitFor("moved on member by a swap", () => clip(member, "d.mp4")?.start === 120);
    // After a swap the member reports the same timeline; nothing bounces back.
    await new Promise((r) => setTimeout(r, 500));
    expect(clip(host, "d.mp4")!.start).toBe(120);
  }, 40_000);
});

describe("the user editing in Resolve, and adds that fail", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const count = (pc: Pc, type: string) => pc.fake.commands.filter((c) => c.type === type).length;

  it.each([
    ["the user is mid-edit", "editing"],
    ["Resolve can't read items back yet", "unreadable"],
  ] as const)("waits while %s, without rebuilding, then applies", async (_, flag) => {
    const host = makePc(`${flag}host`);
    const member = makePc(`${flag}member`, 2); // tier 2: a move is a rebuild, which must wait too
    const code = newInviteCode();
    const media = footage(host, [member], "f.mp4");
    host.fake.timelines.addClip(host.fake.timelines.addTimeline("Edit"), media, "f.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("f.mp4 on member", () => !!clip(member, "f.mp4"));
    const before = clip(member, "f.mp4")!.id;
    member.fake.timelines[flag] = true;
    clip(host, "f.mp4")!.start = 96;
    await sleep(1500);
    expect(clip(member, "f.mp4")!.start).toBe(0);
    expect(count(member, "item.delete")).toBeGreaterThan(0); // it did try
    expect(clip(member, "f.mp4")!.id).toBe(before); // asked, refused, nothing removed
    expect(member.logs.some((l) => l.includes("couldn't"))).toBe(false);
    member.fake.timelines[flag] = false;
    await waitFor("moved on member", () => clip(member, "f.mp4")?.start === 96);
  }, 30_000);

  it("sends Resolve nothing while the mouse button is held, then applies", async () => {
    const host = makePc("mousehost");
    const member = makePc("mousemember");
    const code = newInviteCode();
    const media = footage(host, [member], "h.mp4");
    host.fake.timelines.addClip(host.fake.timelines.addTimeline("Edit"), media, "h.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("h.mp4 on member", () => !!clip(member, "h.mp4"));
    await sleep(500);
    member.busy = true;
    const sent = member.fake.commands.filter((c) => /^(item|track|tl)\./.test(String(c.type))).length;
    clip(host, "h.mp4")!.start = 96;
    await sleep(1500);
    expect(clip(member, "h.mp4")!.start).toBe(0);
    expect(member.fake.commands.filter((c) => /^(item|track|tl)\./.test(String(c.type))).length).toBe(sent);
    member.busy = false;
    await waitFor("moved on member", () => clip(member, "h.mp4")?.start === 96);
  }, 30_000);

  it("tries a failing add once, not over and over, and again when the item changes", async () => {
    const host = makePc("failhost");
    const member = makePc("failmember", 2);
    const code = newInviteCode();
    const media = footage(host, [member], "g.mp4");
    const edit = host.fake.timelines.addTimeline("Edit");
    host.fake.timelines.addClip(edit, media, "g.mp4", 0, 48);
    await connect(host, "host", code);
    await connect(member, "member", code);
    await waitFor("g.mp4 on member", () => !!clip(member, "g.mp4"));
    member.fake.timelines.failing.add("item.add");
    // A move is a rebuild at tier 2: the delete works, the add fails.
    clip(host, "g.mp4")!.start = 96;
    await waitFor("the member tried", () => count(member, "item.add") > 2);
    await sleep(1500);
    const tries = count(member, "item.add");
    // Other changes in Resolve start more passes; none tries the add again.
    for (let i = 0; i < 10; i++) {
      member.session!.timelines.schedule();
      await sleep(150);
    }
    expect(count(member, "item.add")).toBe(tries);
    // The item the rebuild removed isn't taken for a delete by this PC.
    expect(clip(host, "g.mp4")).toBeDefined();
    member.fake.timelines.failing.delete("item.add");
    clip(host, "g.mp4")!.start = 120;
    await waitFor("added on member once the item changed", () => clip(member, "g.mp4")?.start === 120);
  }, 30_000);
});
