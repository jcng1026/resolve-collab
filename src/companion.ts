// ResolveCollab companion, M2 command line (SPEC §18): connects the local
// bridge to peers and forwards "clip added" in both directions.
//
//   node src/companion.ts host                 start a session, prints the invite code
//   node src/companion.ts join <invite-code>   join a session
//
// Options:
//   --inbox <dir>        bridge inbox (default: %USERPROFILE%\ResolveCollab\inbox)
//   --log <file>         Resolve's ResolveDebug.txt (default: the standard location)
//   --fake               use an in-process fake bridge instead of Resolve
//   --fake-media <name>  media file name the fake bridge has (repeatable)
// In --fake mode, type "add <media name> <start frame>" to simulate a local edit.

import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { JsonValue } from "./bridge-protocol/wire.ts";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";

const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
export const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    inbox: { type: "string" },
    log: { type: "string" },
    fake: { type: "boolean", default: false },
    "fake-media": { type: "string", multiple: true, default: [] },
  },
});

const [mode, codeArg] = positionals;
if (mode !== "host" && mode !== "join") {
  console.error("usage: node src/companion.ts host | join <invite-code> [--fake] [--inbox dir] [--log file]");
  process.exit(2);
}
const inviteCode = mode === "host" ? newInviteCode() : (codeArg ?? "");

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${message}`);

let logPath = values.log ?? RESOLVE_LOG;
let inboxDir = values.inbox ?? DEFAULT_INBOX;
let fake: FakeBridge | undefined;
if (values.fake) {
  const dir = mkdtempSync(join(tmpdir(), "rc-fake-"));
  logPath = join(dir, "ResolveDebug.txt");
  inboxDir = join(dir, "inbox");
  writeFileSync(logPath, "");
}

const bridge = new BridgeClient({ logPath, inboxDir });
const peers = new PeerLink(inviteCode);

bridge.on("hello", (hello: Record<string, JsonValue>) => log(`bridge connected: ${hello.product} ${hello.version ?? ""}`));
bridge.on("alive", (alive: boolean) => { if (!alive) log("bridge not responding: start Workspace > Scripts > ResolveCollab in Resolve"); });
bridge.on("error", (error: JsonValue) => log(`bridge error: ${JSON.stringify(error)}`));

// Local edit → peers.
bridge.on("event", (event: Record<string, JsonValue>) => {
  if (event.type !== "clip.added") return;
  log(`local clip added: ${JSON.stringify(event.media)} at ${event.start} on V${event.track}; sending to ${peers.peerCount} peer(s)`);
  peers.send({ type: "op", op: event });
});

// Peer edit → local bridge.
peers.on("message", async (message: Record<string, JsonValue>, from: string) => {
  if (message.type !== "op") return;
  const op = message.op as Record<string, JsonValue>;
  if (op.type !== "clip.added") return;
  const started = Date.now();
  const result = await bridge.send({ ...op, type: "clip.append" });
  log(`peer ${from} added ${JSON.stringify(op.media)} at ${op.start}: ${result.ok ? "applied" : `NOT applied (${result.error})`} in ${Date.now() - started} ms`);
});
peers.on("peer", (id: string) => log(`peer ${id} connected`));
peers.on("peer-left", (id: string) => log(`peer ${id} left`));

bridge.start();
if (values.fake) {
  fake = new FakeBridge(logPath, inboxDir);
  for (const name of values["fake-media"]) fake.media.add(name);
  fake.start();
  createInterface({ input: process.stdin }).on("line", (line) => {
    const [command, name, start] = line.trim().split(/\s+/);
    if (command !== "add" || !name || !start) return;
    fake!.media.add(name);
    fake!.addLocalClip({ timeline: "Timeline 1", track: 1, start: Number(start), end: Number(start) + 48,
      srcStart: 0, srcEnd: 48, media: { name, path: `C:\\fake\\${name}`, frames: 240 } });
  });
}

await peers.start();
log(`${mode === "host" ? "hosting" : "joined"} session as ${peers.id}`);
if (mode === "host") log(`invite code: ${inviteCode}`);
log(`bridge inbox: ${inboxDir}`);

const shutdown = async () => {
  bridge.stop();
  fake?.stop();
  await peers.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
