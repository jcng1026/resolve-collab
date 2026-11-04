// ResolveCollab companion command line (SPEC §18–§20): connects the local
// bridge to the session and keeps the media pool and timelines in sync.
//
//   node src/companion.ts host [--code <invite-code>]   start a session (or resume one with its code)
//   node src/companion.ts join <invite-code>            join a session
//
// Options:
//   --inbox <dir>        bridge inbox (default: %USERPROFILE%\ResolveCollab\inbox)
//   --log <file>         Resolve's ResolveDebug.txt (default: the standard location)
//   --fake               use an in-process fake bridge instead of Resolve
//   --force-tier <2|3>   apply timeline changes by rebuilding items (2) or
//                        swapping whole timelines (3), to test those paths
//
// Type while it runs:
//   missing                    list clips whose media this PC lacks
//   locate <clip> <path>       use your own copy of a missing clip's file

import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { findFile, fingerprint, userFolders } from "./media/fingerprint.ts";
import { PeerLink, newInviteCode, topicFor } from "./peer/peer-link.ts";
import { MouseWatch } from "./bridge/mouse-watch.ts";
import { Session } from "./session.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";

const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
export const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    code: { type: "string" },
    inbox: { type: "string" },
    log: { type: "string" },
    fake: { type: "boolean", default: false },
    "force-tier": { type: "string" },
  },
});

const [mode, codeArg] = positionals;
if ((mode !== "host" && mode !== "join") || (mode === "join" && !codeArg)) {
  console.error("usage: node src/companion.ts host [--code <invite-code>] | join <invite-code> [--fake] [--inbox dir] [--log file]");
  process.exit(2);
}
const inviteCode = mode === "host" ? (values.code ?? newInviteCode()) : codeArg!;
if (!/^[0-9a-f]{32}$/.test(inviteCode)) {
  console.error("an invite code is 32 hex characters");
  process.exit(2);
}

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${message}`);

const forceTier = values["force-tier"] === undefined ? undefined : Number(values["force-tier"]);
if (forceTier !== undefined && forceTier !== 2 && forceTier !== 3) {
  console.error("--force-tier is 2 or 3");
  process.exit(2);
}

let logPath = values.log ?? RESOLVE_LOG;
let inboxDir = values.inbox ?? DEFAULT_INBOX;
if (values.fake) {
  const dir = mkdtempSync(join(tmpdir(), "rc-fake-"));
  logPath = join(dir, "ResolveDebug.txt");
  inboxDir = join(dir, "inbox");
  writeFileSync(logPath, "");
}
// The bridge only writes backups under <inbox parent>\backups (SPEC §19.4).
const home = dirname(inboxDir);
const topic = topicFor(inviteCode).toString("hex").slice(0, 16);

const bridge = new BridgeClient({ logPath, inboxDir });
const peers = new PeerLink(inviteCode);

// --- terminal -------------------------------------------------------------------

const terminal = createInterface({ input: process.stdin });
let answerLine: ((line: string) => void) | undefined;
const nextLine = () => new Promise<string>((resolve) => { answerLine = resolve; });

function describe(c: Conflict): string {
  const what = `${c.item} "${c.label}"`;
  if (c.kind === "clash") {
    const m = (v: unknown) => { const x = v as { name: string; color: string }; return `"${x.name}" (${x.color})`; };
    const frame = (c.mine as { frame: number }).frame;
    return `two markers on frame ${frame}, and only one fits: yours ${m(c.mine)}, theirs ${m(c.theirs)}.  mine = keep yours, theirs = keep theirs`;
  }
  if (c.kind === "field") return `${what}: ${c.field} is ${JSON.stringify(c.mine)} here, ${JSON.stringify(c.theirs)} in the session`;
  if (c.kind === "deleted-here") return `${what}: you deleted it; someone changed it.  mine = keep it deleted, theirs = bring it back`;
  return `${what}: you changed it; someone deleted it.  mine = keep your version, theirs = delete it`;
}

// Keep mine / Keep theirs for each conflict, with "for all" (SPEC §9.3).
async function ask(conflicts: Conflict[]): Promise<Map<string, Answer>> {
  const answers = new Map<string, Answer>();
  log(`${conflicts.length} change(s) here conflict with the session. A backup of this project is saved before anything changes.`);
  let all: Answer | undefined;
  for (const [i, c] of conflicts.entries()) {
    if (!all) {
      console.log(`  ${i + 1}/${conflicts.length}  ${describe(c)}`);
      for (;;) {
        console.log("        m = keep mine, t = keep theirs, M = mine for all the rest, T = theirs for all the rest");
        const line = (await nextLine()).trim();
        if (line === "m" || line === "t") {
          answers.set(c.key, line === "m" ? "mine" : "theirs");
          break;
        }
        if (line === "M" || line === "T") {
          all = line === "M" ? "mine" : "theirs";
          break;
        }
      }
    }
    if (all) answers.set(c.key, all);
  }
  log("answers sent");
  return answers;
}

// A yes/no question (SPEC §20.5: deleting a timeline for everyone).
async function confirm(question: string): Promise<boolean> {
  for (;;) {
    console.log(`  ${question}  y = yes, n = no`);
    const line = (await nextLine()).trim().toLowerCase();
    if (line === "y" || line === "n") return line === "y";
  }
}

const mouse = new MouseWatch(log);
mouse.start();

const session = new Session({
  role: mode === "host" ? "host" : "member",
  bridge,
  peers,
  storeDir: join(home, "sessions", topic),
  backupsDir: join(home, "backups"),
  ask,
  confirm,
  fingerprint,
  findFile: (file, dirs) => findFile(file, [...dirs, ...userFolders()]),
  log,
  ...(forceTier ? { forceTier: forceTier as 2 | 3 } : {}),
  userBusy: () => mouse.held,
});

let fake: FakeBridge | undefined;
terminal.on("line", async (line) => {
  if (answerLine) {
    const answer = answerLine;
    answerLine = undefined;
    answer(line);
    return;
  }
  const [command, ...rest] = line.trim().split(/\s+/);
  if (command === "missing") {
    const missing = [...session.sync.missing.values()];
    if (!missing.length) log("no missing media");
    for (const clip of missing) log(`missing: ${clip.id.slice(0, 8)}  "${clip.name}"`);
  } else if (command === "locate" && rest.length >= 2) {
    // The path may contain spaces; quotes from Explorer's "Copy as path" are dropped.
    log(await session.sync.locate(rest[0]!, rest.slice(1).join(" ").replace(/^"(.*)"$/, "$1")));
  } else if (command) {
    log("commands: missing | locate <clip> <path>");
  }
});

bridge.start();
if (values.fake) {
  fake = new FakeBridge(logPath, inboxDir);
  fake.start();
}

await peers.start();
log(`${mode === "host" ? "hosting" : "joined"} session as ${peers.id}`);
if (mode === "host") log(`invite code: ${inviteCode}  (to resume this session later: host --code ${inviteCode})`);
log(`bridge inbox: ${inboxDir}`);

const shutdown = async () => {
  session.stop();
  mouse.stop();
  bridge.stop();
  fake?.stop();
  await peers.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
