// ResolveCollab companion command line (SPEC §18–§22): connects the local
// bridge to the session and keeps the media pool and timelines in sync.
//
//   node src/companion.ts host               start a new session from the project open in Resolve
//   node src/companion.ts host --resume      reopen the session that project belongs to
//   node src/companion.ts join <invite-code> join a session (a first join makes a new project)
//
// Every opening of a session has a new invite code (SPEC §22.1).
//
// Options:
//   --name <name>        your name, shown to others (asked once otherwise)
//   --inbox <dir>        bridge inbox (default: %USERPROFILE%\ResolveCollab\inbox)
//   --log <file>         Resolve's ResolveDebug.txt (default: the standard location)
//   --fake               use an in-process fake bridge instead of Resolve
//   --force-tier <2|3>   apply timeline changes by rebuilding items (2) or
//                        swapping whole timelines (3), to test those paths
//
// Type while it runs:
//   missing                    list clips whose media this PC lacks
//   locate <clip> <path>       use your own copy of a missing clip's file
//   members                    (host) who's in, and who's blocked
//   remove <name or ID>        (host) disconnect and block a member
//   unblock <name or ID>       (host) let a blocked PC ask again
//   end                        (host) end the session for good

import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { localBridgeBuild } from "./bridge/bridge-build.ts";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { findFile, fingerprint, userFolders } from "./media/fingerprint.ts";
import { loadIdentity, saveName, validName } from "./peer/identity.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { MouseWatch } from "./bridge/mouse-watch.ts";
import { UndoKeys } from "./bridge/undo-keys.ts";
import { type Approval, Session } from "./session.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";

const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
export const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    resume: { type: "boolean", default: false },
    name: { type: "string" },
    inbox: { type: "string" },
    log: { type: "string" },
    fake: { type: "boolean", default: false },
    "force-tier": { type: "string" },
  },
});

const [mode, codeArg] = positionals;
if ((mode !== "host" && mode !== "join") || (mode === "join" && !codeArg) || (mode === "join" && values.resume)) {
  console.error("usage: node src/companion.ts host [--resume] | join <invite-code>   [--name you] [--fake] [--inbox dir] [--log file]");
  process.exit(2);
}
const inviteCode = mode === "host" ? newInviteCode() : codeArg!;
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

// Asked when someone not let in before asks to join (SPEC §22.3).
async function approve(name: string, peer: string): Promise<Approval> {
  for (;;) {
    console.log(`  ${name} (${peer}) wants to join.  y = let in, n = not now, b = block this PC`);
    const line = (await nextLine()).trim().toLowerCase();
    if (line === "y") return "yes";
    if (line === "n") return "no";
    if (line === "b") return "block";
  }
}

// One question at a time: the terminal has a single answer line, and the
// media pool and timeline syncs can ask at the same moment.
let turn: Promise<unknown> = Promise.resolve();
function oneAtATime<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => {
    const run = turn.then(() => fn(...args));
    turn = run.catch(() => {});
    return run;
  };
}
const askInTurn = oneAtATime(ask);
const confirmInTurn = oneAtATime(confirm);
const approveInTurn = oneAtATime(approve);

// This PC's lasting identity and the person's name (SPEC §22.1).
if (values.name !== undefined) {
  if (!validName(values.name)) {
    console.error("a name is 1 to 40 characters");
    process.exit(2);
  }
  saveName(home, values.name);
}
let identity = loadIdentity(home);
while (!identity.name) {
  // The interface has no output stream, so question() prints nothing: write
  // the question ourselves.
  process.stdout.write("  Your name, shown to the others in the session: ");
  const line = (await new Promise<string>((resolve) => terminal.question("", resolve))).trim();
  if (validName(line)) {
    saveName(home, line);
    identity = loadIdentity(home);
  }
}

const bridge = new BridgeClient({ logPath, inboxDir });
const peers = new PeerLink(inviteCode, { seed: identity.seed });

const mouse = new MouseWatch(log);
mouse.start();

// Set before the session exists: it can end while the companion is still
// starting (for example, a join refused straight away).
let stopping = false;

const session = new Session({
  role: mode === "host" ? "host" : "member",
  bridge,
  peers,
  storeDir: join(home, "sessions"),
  backupsDir: join(home, "backups"),
  name: identity.name,
  resume: values.resume,
  approve: approveInTurn,
  onEnded: () => void shutdown(),
  // Chat from the others shows in the terminal until the window does it (SPEC §24).
  onLine: (line) => { if (line.kind === "chat" && line.author !== peers.id) log(`${line.name}: ${line.text}`); },
  ask: askInTurn,
  confirm: confirmInTurn,
  fingerprint,
  findFile: (file, dirs) => findFile(file, [...dirs, ...userFolders()]),
  log,
  ...(forceTier ? { forceTier: forceTier as 2 | 3 } : {}),
  userBusy: () => mouse.held,
  ...(values.fake ? {} : { bridgeBuild: localBridgeBuild() }),
});

// Ctrl+Z / Ctrl+Shift+Z undo and redo this person's own changes while Resolve
// is in front on a synced page (SPEC §23.2); elsewhere they stay Resolve's.
const UNDO_PAGES = new Set(["media", "cut", "edit"]);
const keys = new UndoKeys();
let resolveAnswers = true;
const allowKeys = () => keys.allow(resolveAnswers && session.begun && UNDO_PAGES.has(bridge.page ?? ""));
bridge.on("page", allowKeys);
bridge.on("alive", (alive: boolean) => {
  resolveAnswers = alive;
  allowKeys();
});
const keysTimer = setInterval(allowKeys, 1000); // the session can begin after the page was last told
let undoing = false;
async function undoKey(redo: boolean): Promise<void> {
  if (undoing) return; // one at a time: a question may be waiting
  undoing = true;
  try {
    log(await (redo ? session.redo() : session.undo()));
  } finally {
    undoing = false;
  }
}
keys.on("undo", () => void undoKey(false));
keys.on("redo", () => void undoKey(true));
keys.on("taken", () => log("another program has claimed Ctrl+Z, so it stays Resolve's; type undo / redo here instead"));
keys.on("gone", () => log("can't claim Ctrl+Z any more, so it's Resolve's again; type undo / redo here instead"));
if (!values.fake) keys.start();

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
  } else if (command === "chat" && rest.length) {
    session.chat(rest.join(" "));
  } else if (command === "undo") {
    log(await session.undo());
  } else if (command === "redo") {
    log(await session.redo());
  } else if (command === "restore" && /^\d+$/.test(rest[0] ?? "")) {
    log(session.restore(Number(rest[0])));
  } else if (command === "reapply" && /^\d+$/.test(rest[0] ?? "")) {
    log(session.reapply(Number(rest[0])));
  } else if (command === "members" && mode === "host") {
    const list = session.memberList();
    log(list.length ? `members:\n    ${list.join("\n    ")}` : "nobody has joined yet");
  } else if (command === "remove" && mode === "host" && rest.length) {
    log(session.remove(rest.join(" ")));
  } else if (command === "unblock" && mode === "host" && rest.length) {
    log(session.unblock(rest.join(" ")));
  } else if (command === "end" && mode === "host") {
    if (await confirmInTurn("End this session for good? It can't be resumed afterwards.")) session.endForGood();
  } else if (command) {
    const common = "chat <message> | missing | locate <clip> <path> | undo | redo | reapply <n> | restore <n>";
    log(mode === "host" ? `commands: ${common} | members | remove <name> | unblock <name> | end` : `commands: ${common}`);
  }
});

bridge.start();
if (values.fake) {
  fake = new FakeBridge(logPath, inboxDir);
  fake.start();
}

// Said before the peer link starts: the host can answer while it's still starting.
log(`you are ${identity.name} (${peers.id})`);
log(`bridge inbox: ${inboxDir}`);
if (mode === "join") log("looking for the host ...");
await peers.start();
if (mode === "host") {
  log(`invite code: ${inviteCode}`);
  log("Share it with the people joining. It works until you close this companion; next time, host --resume gives a new one.");
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await session.close();
  mouse.stop();
  clearInterval(keysTimer);
  keys.stop();
  bridge.stop();
  fake?.stop();
  await peers.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
