// Five PCs (SPEC §16 M7, §23.4): a host and four members with fake bridges on
// a local testnet, over a jittery network that delays and reorders messages.
// Everyone edits the same clips at the same moments; then everyone undoes at
// once; then one PC is cut off, edits, and comes back. After each round every
// PC's Resolve shows the same thing as the host's session.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge, type FakePoolClip } from "./bridge/fake-bridge.ts";
import { findFile, fingerprint } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { Session } from "./session.ts";
import type { SessionModel } from "./sync/session-model.ts";

let testnet: Awaited<ReturnType<typeof createTestnet>>;

interface Pc {
  name: string;
  dir: string;
  media: string;
  fake: FakeBridge;
  bridge?: BridgeClient;
  peers?: PeerLink;
  session?: Session;
  logs: string[];
  jitter: number; // up to this many ms of delay on each message received
}

const FILES = ["one.mp4", "two.mp4", "three.mp4"];
const COLORS = ["Orange", "Apricot", "Yellow", "Lime", "Olive", "Green", "Teal", "Navy", "Blue", "Purple", "Violet", "Pink"];
const pcs: Pc[] = [];

async function waitFor(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      const session = (p: Pc) => FILES.map((f) => Object.values(model(p).pool.clips).find((c) => c.name === f)).map((c) => c && { color: c.color, flags: c.flags, meta: c.meta });
      const state = pcs.map((p) => `--- ${p.name}\n  resolve: ${JSON.stringify(view(p))}\n  session: ${p.session ? JSON.stringify(session(p)) : "-"}\n${p.logs.slice(-12).join("\n")}`);
      throw new Error(`timed out waiting for ${what}\n${state.join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A small, seeded random source, so a failure can be run again the same way.
let seed = Number(process.env.RC_SEED ?? 12345);
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;

function makePc(name: string): Pc {
  const dir = mkdtempSync(join(tmpdir(), `rc-5-${name}-`));
  const media = join(dir, "media");
  mkdirSync(media);
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "ResolveDebug.txt"), "");
  for (const f of FILES) writeFileSync(join(media, f), `${f} content `.repeat(300));
  const pc: Pc = { name, dir, media, fake: new FakeBridge(join(dir, "ResolveDebug.txt"), join(dir, "inbox")), logs: [], jitter: 0 };
  pc.fake.start();
  pcs.push(pc);
  return pc;
}

async function connect(pc: Pc, role: "host" | "member", code: string, resume = false): Promise<void> {
  pc.bridge = new BridgeClient({ logPath: join(pc.dir, "ResolveDebug.txt"), inboxDir: join(pc.dir, "inbox"), pollMs: 20 });
  pc.peers = new PeerLink(code, { bootstrap: testnet.bootstrap, seed: createHash("sha256").update(pc.dir).digest(), delay: () => random() * pc.jitter });
  pc.session = new Session({
    role, bridge: pc.bridge, peers: pc.peers, storeDir: join(pc.dir, "store"), backupsDir: join(pc.dir, "backups"), name: pc.name,
    approve: async () => "yes", ...(resume ? { resume } : {}),
    confirm: async () => true,
    // A returning PC keeps the session's version (the other answer is tested elsewhere).
    ask: async (conflicts) => new Map(conflicts.map((c) => [c.key, "theirs"])),
    fingerprint,
    findFile: (file, dirs) => findFile(file, [...dirs, pc.media]),
    log: (m) => pc.logs.push(m),
  });
  pc.bridge.start();
  await pc.peers.start();
}

async function cut(pc: Pc): Promise<void> {
  pc.session!.stop();
  pc.bridge!.stop();
  await pc.peers!.stop();
}

const clipOf = (pc: Pc, file: string): FakePoolClip | undefined => [...pc.fake.poolClips.values()].find((c) => basename(c.path) === file);
const view = (pc: Pc) => FILES.map((f) => {
  const c = clipOf(pc, f);
  return c && { color: c.color, flags: [...c.flags].sort(), meta: c.meta };
});
const model = (pc: Pc): SessionModel => {
  const s = pc.session as unknown as { host?: { model: SessionModel }; member: { model: SessionModel } };
  return s.host ? s.host.model : s.member.model;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const settled = (all: Pc[]) => all.every((pc) => same(view(pc), view(all[0]!)) && same(model(pc).pool.clips, model(all[0]!).pool.clips));

// Random edits on every PC at once: a colour, a metadata key or a flag.
async function edits(all: Pc[], rounds: number): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    for (const pc of all) {
      const clip = clipOf(pc, pick(FILES));
      if (!clip) continue;
      const what = random();
      if (what < 0.5) clip.color = pick(COLORS);
      else if (what < 0.8) clip.meta = { ...clip.meta, Scene: String(Math.floor(random() * 9)) };
      else clip.flags = clip.flags.includes("Red") ? clip.flags.filter((f) => f !== "Red") : [...clip.flags, "Red"].sort();
    }
    await sleep(40 + random() * 120);
  }
}

describe("five PCs at once (SPEC §23.4)", () => {
  const host = makePc("host");
  const members = ["jo", "alex", "kim", "sam"].map(makePc);
  const all = [host, ...members];
  const code = newInviteCode();

  beforeAll(async () => {
    testnet = await createTestnet(3);
    for (const f of FILES) host.fake.importClip(join(host.media, f));
    await connect(host, "host", code);
    for (const m of members) await connect(m, "member", code);
    await waitFor("everyone has the clips", () => members.every((m) => FILES.every((f) => clipOf(m, f))), 60_000);
    for (const pc of all) pc.jitter = 60; // from now on, messages are delayed and reordered
  }, 90_000);
  afterAll(async () => {
    for (const pc of all) {
      pc.fake.stop();
      if (pc.peers) await cut(pc).catch(() => {});
    }
    await testnet.destroy();
  });

  it("ends the same everywhere after everyone edits the same clips at the same moments, and losers are told", async () => {
    await edits(all, 12);
    await waitFor("all five the same", () => settled(all), 60_000);
    await sleep(1500); // and it stays that way
    expect(settled(all)).toBe(true);
    const notices = all.flatMap((pc) => pc.logs.filter((l) => l.includes("at the same moment")));
    expect(notices.length).toBeGreaterThan(0); // someone lost a race and was told
    // "someone": the winner's change came inside a full state, not a commit.
    for (const n of notices) expect(n).toMatch(/^\[\d+\] (host|jo|alex|kim|sam|Others|someone) changed .* reapply \d+ = send yours again$/);
  }, 120_000);

  it("ends the same everywhere after several PCs undo and redo at once", async () => {
    const results = await Promise.all(members.map((m) => m.session!.undo()));
    expect(results.some((r) => r.startsWith("undid"))).toBe(true);
    await waitFor("same after undos", () => settled(all), 60_000);
    await Promise.all(members.slice(0, 2).map((m) => m.session!.redo()));
    await waitFor("same after redos", () => settled(all), 60_000);
  }, 120_000);

  it("ends the same everywhere after one PC is cut off, edits, and comes back", async () => {
    const kim = members[2]!;
    await cut(kim);
    await edits([kim], 3); // offline, kept on Kim's PC
    await edits([host, ...members.filter((m) => m !== kim)], 4);
    await sleep(300);
    await connect(kim, "member", code);
    await waitFor("same after Kim is back", () => settled(all), 60_000);
  }, 120_000);
});
