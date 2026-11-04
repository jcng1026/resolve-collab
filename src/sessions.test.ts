// Sessions (SPEC §22): companions with fake bridges over a local DHT testnet.
// Joining (a fresh project, approval, refusing and blocking), rejoining with
// a new code, the host closing or dropping out, ending for good, removing a
// member, and a stranger answering as the host.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { findFile, fingerprint } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode, topicFor } from "./peer/peer-link.ts";
import { type Approval, Session } from "./session.ts";
import { loadRecord } from "./session-record.ts";

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
  ended?: string | undefined;
  approve: (name: string) => Promise<Approval>;
  asked: string[];
  seed: Buffer;
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

function makePc(name: string): Pc {
  const dir = mkdtempSync(join(tmpdir(), `rc-ss-${name}-`));
  const media = join(dir, "media");
  mkdirSync(media);
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "ResolveDebug.txt"), "");
  const pc: Pc = {
    name, dir, media, fake: new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox")), logs: [], asked: [],
    approve: async () => "yes", seed: createHash("sha256").update(dir).digest(),
  };
  pc.fake.start();
  all.push(pc);
  return pc;
}

async function connect(pc: Pc, role: "host" | "member", code: string, extra: { resume?: boolean; graceMs?: number } = {}): Promise<void> {
  pc.ended = undefined;
  pc.bridge = new BridgeClient({ logPath: join(pc.dir, "ResolveDebug.txt"), inboxDir: join(pc.dir, "inbox"), pollMs: 20 });
  pc.peers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: pc.seed });
  pc.session = new Session({
    role, bridge: pc.bridge, peers: pc.peers, storeDir: join(pc.dir, "store"), backupsDir: join(pc.dir, "backups"), name: pc.name,
    approve: (name) => {
      pc.asked.push(name);
      return pc.approve(name);
    },
    onEnded: (why) => { pc.ended = why; },
    confirm: async () => true,
    ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "mine"])),
    fingerprint,
    findFile: (file, dirs) => findFile(file, [...dirs, pc.media]),
    log: (m) => pc.logs.push(m),
    ...extra,
  });
  pc.bridge.start();
  // The bridge in Resolve was already running: its state is asked for again.
  await pc.peers.start();
}

// The companion closes (Ctrl+C); the bridge in Resolve keeps running.
async function close(pc: Pc, goodbye = true): Promise<void> {
  if (goodbye) await pc.session!.close();
  else pc.session!.stop();
  pc.bridge!.stop();
  await pc.peers!.stop();
}

function footage(host: Pc, others: Pc[], name: string): string {
  for (const pc of [host, ...others]) writeFileSync(join(pc.media, name), `${name}`.repeat(500));
  return host.fake.importClip(join(host.media, name)).id;
}

const clipIn = (pc: Pc, name: string) => !!pc.fake.clipByName(name);

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  for (const pc of all) {
    pc.fake.stop();
    if (pc.peers) await close(pc, false).catch(() => {});
  }
  await testnet.destroy();
});

describe("joining a session (SPEC §22.3)", () => {
  const host = makePc("Sam");
  const jo = makePc("Jo");
  const alex = makePc("Alex");
  const code = newInviteCode();

  it("makes a fresh project on a first join, and leaves the open project as it was", async () => {
    footage(host, [jo, alex], "a.mp4");
    writeFileSync(join(jo.media, "mine.mp4"), "only on Jo's PC".repeat(200));
    jo.fake.importClip(join(jo.media, "mine.mp4"));
    const before = jo.fake.project;
    await connect(host, "host", code);
    await connect(jo, "member", code);
    await waitFor("Jo in", () => jo.logs.some((l) => l.startsWith("joined the session hosted by Sam")));
    expect(jo.logs).toContain(`made the project "Fake Project (collab · hosted by Sam)" for this session`);
    expect(jo.fake.project.name).toBe("Fake Project (collab · hosted by Sam)");
    await waitFor("the host's clip in Jo's new project", () => clipIn(jo, "a.mp4"));
    expect(clipIn(jo, "mine.mp4")).toBe(false);
    expect(clipIn(host, "mine.mp4")).toBe(false); // nothing of Jo's old project went to the session
    // Jo's old project is untouched.
    const joined = jo.fake.project;
    jo.fake.switchProject(before);
    await sleep(400);
    expect(clipIn(jo, "mine.mp4")).toBe(true);
    expect(clipIn(jo, "a.mp4")).toBe(false);
    jo.fake.switchProject(joined);
    await waitFor("Jo back on the session's project", () => jo.logs.some((l) => l.startsWith("Back on")));
  }, 30_000);

  it("keeps a joiner waiting until the host lets them in, and sends nothing before", async () => {
    let letIn!: (a: Approval) => void;
    host.approve = () => new Promise((r) => { letIn = r; });
    await connect(alex, "member", code);
    await waitFor("the host asked", () => host.asked.includes("Alex"));
    await waitFor("Alex told to wait", () => alex.logs.includes("waiting for Sam to let you in"));
    await sleep(500);
    expect(alex.session!.begun).toBe(false);
    expect(alex.fake.project.name).toBe("Fake Project"); // no project made yet
    letIn("yes");
    await waitFor("Alex in, with the host's clip", () => alex.logs.some((l) => l.startsWith("joined the session")) && clipIn(alex, "a.mp4"));
  }, 30_000);

  it("refuses and blocks", async () => {
    const kim = makePc("Kim");
    host.approve = async () => "no";
    await connect(kim, "member", code);
    await waitFor("Kim refused", () => kim.ended === "The host didn't let you in.");
    await close(kim, false);
    const lee = makePc("Lee");
    host.approve = async () => "block";
    await connect(lee, "member", code);
    await waitFor("Lee refused", () => lee.ended === "The host has blocked this PC from the session.");
    await close(lee, false);
    // Blocked: refused again without asking.
    const asked = host.asked.length;
    await connect(lee, "member", code);
    await waitFor("Lee refused again", () => lee.ended === "The host has blocked this PC from the session.");
    expect(host.asked.length).toBe(asked);
    await close(lee, false);
    expect(host.session!.memberList()).toEqual(expect.arrayContaining([expect.stringMatching(/^Lee \([0-9a-f]{8}\) blocked$/)]));
  }, 40_000);
});

describe("closing, resuming and dropping out (SPEC §22.2, §22.4)", () => {
  const host = makePc("Sam");
  const jo = makePc("Jo");

  it("ends the session for members when the host closes, and lets a known PC back in with a new code", async () => {
    footage(host, [jo], "b.mp4");
    const first = newInviteCode();
    await connect(host, "host", first);
    await connect(jo, "member", first);
    await waitFor("Jo in", () => clipIn(jo, "b.mp4"));
    const project = jo.fake.project.id;
    await close(host);
    await waitFor("Jo told", () => jo.ended?.startsWith("Sam closed the session") === true);
    await close(jo, false);

    // Another day: the host resumes (a new code), Jo rejoins with it.
    const second = newInviteCode();
    const asked = host.asked.length;
    await connect(host, "host", second, { resume: true });
    await waitFor("resumed", () => host.logs.includes(`resuming the session for "Fake Project"`));
    await connect(jo, "member", second);
    await waitFor("Jo back", () => jo.logs.includes(`rejoined the session for "Fake Project (collab · hosted by Sam)"`));
    expect(host.asked.length).toBe(asked); // not asked again
    expect(jo.fake.project.id).toBe(project); // the project from last time
    host.fake.clipByName("b.mp4")!.color = "Blue";
    await waitFor("edits sync again", () => jo.fake.clipByName("b.mp4")?.color === "Blue");
    // The old code finds nobody.
    expect(first).not.toBe(second);
  }, 60_000);

  it("refuses a PC that reaches the host with an older code (§22.1)", async () => {
    // Opened once with the first code (Jo was let in then), then resumed with
    // a new one. The old code's announcement can linger on the DHT and the
    // host's key is lasting, so the resumed host is still reachable on the
    // old topic: here it listens on it too, as that stale announcement would.
    const host2 = makePc("Kim");
    const ann = makePc("Ann");
    footage(host2, [ann], "c.mp4");
    const first = newInviteCode();
    await connect(host2, "host", first);
    await connect(ann, "member", first);
    await waitFor("Ann in", () => clipIn(ann, "c.mp4"));
    await close(host2);
    await waitFor("Ann told", () => ann.ended !== undefined);
    await close(ann, false);

    const second = newInviteCode();
    await connect(host2, "host", second, { resume: true });
    await waitFor("resumed", () => host2.logs.some((l) => l.startsWith("resuming the session")));
    const swarm = (host2.peers as unknown as { swarm: { join(topic: Buffer, o: object): { flushed(): Promise<void> } } }).swarm;
    await swarm.join(topicFor(first), { server: true, client: false }).flushed();
    await connect(ann, "member", first);
    await waitFor("Ann refused", () => ann.ended !== undefined, 20_000);
    expect(ann.ended).toContain("earlier opening");
    expect(ann.logs.some((l) => l.startsWith("rejoined"))).toBe(false);
    expect(host2.logs.some((l) => l.includes("rejoined"))).toBe(false);
    await close(ann, false);
    await close(host2);
  }, 60_000);

  it("waits for a host whose connection dropped, and ends after the grace time", async () => {
    const code = newInviteCode();
    await close(host, false);
    await close(jo, false);
    await connect(host, "host", code, { resume: true });
    await connect(jo, "member", code, { graceMs: 2500 });
    await waitFor("Jo in", () => jo.logs.filter((l) => l.startsWith("joined the session")).length > 0 && jo.session!.begun);
    // The host's connection drops (no goodbye) and comes back within the grace time.
    await close(host, false);
    await waitFor("Jo offline", () => jo.logs.some((l) => l.startsWith("Offline: the host is unreachable")));
    await connect(host, "host", code, { resume: true });
    await waitFor("Jo reconnected", () => jo.logs.filter((l) => l.startsWith("joined the session")).length >= 2, 20_000);
    expect(jo.ended).toBeUndefined();
    // Dropped again, and gone for longer than the grace time.
    await close(host, false);
    await waitFor("ended after the grace time", () => jo.ended?.startsWith("The host didn't come back") === true, 10_000);
    await close(jo, false);
  }, 60_000);

  it("can't resume a project that isn't a hosted session", async () => {
    const other = makePc("Other");
    await connect(other, "host", newInviteCode(), { resume: true });
    await waitFor("refused", () => other.ended?.includes("isn't a session you host") === true);
    await close(other, false);
  }, 20_000);
});

describe("ending for good and removing (SPEC §22.2, §22.5)", () => {
  const host = makePc("Sam");
  const jo = makePc("Jo");
  const alex = makePc("Alex");
  const code = newInviteCode();

  it("removes a member and blocks their PC", async () => {
    footage(host, [jo, alex], "c.mp4");
    await connect(host, "host", code);
    await connect(jo, "member", code);
    await connect(alex, "member", code);
    await waitFor("both in", () => clipIn(jo, "c.mp4") && clipIn(alex, "c.mp4"));
    expect(host.session!.remove("Jo")).toMatch(/^Jo \([0-9a-f]{8}\) removed and blocked$/);
    await waitFor("Jo told", () => jo.ended === "Sam removed this PC from the session.");
    expect(loadRecord(join(jo.dir, "store"), jo.session!.record!.id)?.ended).toBe(true);
    await close(jo, false);
    // Alex keeps going.
    host.fake.clipByName("c.mp4")!.color = "Green";
    await waitFor("Alex still syncing", () => alex.fake.clipByName("c.mp4")?.color === "Green");
    // Jo can't come back.
    await connect(jo, "member", code);
    await waitFor("Jo refused", () => jo.ended !== undefined);
    await close(jo, false);
    expect(host.session!.unblock("Jo")).toMatch(/can ask to join again$/);
  }, 40_000);

  it("ends the session for good: members are told, and it can't be resumed", async () => {
    const id = host.session!.record!.id;
    host.session!.endForGood();
    await waitFor("Alex told", () => alex.ended === "Sam ended the session for good.");
    await waitFor("host done", () => host.ended !== undefined);
    expect(loadRecord(join(host.dir, "store"), id)?.ended).toBe(true);
    await close(host, false);
    await close(alex, false);
    await connect(host, "host", newInviteCode(), { resume: true });
    await waitFor("can't resume", () => host.ended?.includes("isn't a session you host") === true);
    await close(host, false);
  }, 30_000);
});

describe("a stranger answering as the host (SPEC §22.3)", () => {
  it("is ignored by a member who joined before", async () => {
    const host = makePc("Sam");
    const jo = makePc("Jo");
    const first = newInviteCode();
    await connect(host, "host", first);
    await connect(jo, "member", first);
    await waitFor("Jo in", () => jo.session!.begun && jo.logs.some((l) => l.startsWith("joined")));
    const id = jo.session!.record!.id;
    await close(host);
    await close(jo, false);
    // Someone else, on a code Jo was given, answers with Sam's session ID.
    const code = newInviteCode();
    const stranger = new PeerLink(code, { bootstrap: testnet.bootstrap });
    stranger.on("message", (m: { type?: string }, from: string) => {
      if (m.type !== "join") return;
      stranger.sendTo(from, { type: "welcome", host: stranger.id, session: { id, hostName: "Sam", projectName: "Fake Project" },
        state: { seq: 0, model: { pool: { bins: { root: { id: "root", name: "Master", parent: "" } }, clips: {} }, timelines: { timelines: {}, tracks: {}, items: {} } } } });
    });
    await stranger.start();
    await connect(jo, "member", code);
    await waitFor("Jo ignores it", () => jo.logs.some((l) => l.includes("it answered as the host of this session, but it isn't the PC that hosts it")));
    expect(jo.session!.begun).toBe(false);
    await stranger.stop();
    await close(jo, false);
  }, 30_000);
});
