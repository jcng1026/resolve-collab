// ResolveCollab companion (SPEC §18–§24): connects the local bridge to the
// session, keeps the media pool and timelines in sync, and shows the window.
//
//   node src/companion.ts                    open the window: host, resume or join there
//   node src/companion.ts host               start a new session from the project open in Resolve
//   node src/companion.ts host --resume      reopen the session that project belongs to
//   node src/companion.ts join <invite-code> join a session (a first join makes a new project)
//
// Every opening of a session has a new invite code (SPEC §22.1).
//
// Options:
//   --name <name>        your name, shown to others (asked once otherwise)
//   --no-window          the terminal only
//   --inbox <dir>        bridge inbox (default: %USERPROFILE%\ResolveCollab\inbox)
//   --log <file>         Resolve's ResolveDebug.txt (default: the standard location)
//   --fake               use an in-process fake bridge instead of Resolve
//   --force-tier <2|3>   apply timeline changes by rebuilding items (2) or
//                        swapping whole timelines (3), to test those paths
//
// Type while it runs (the window has buttons for all of these, SPEC §24):
//   chat <message>, missing, locate <clip> <path>, undo, redo, reapply <n>, restore <n>,
//   and as host: members, remove <name or ID>, unblock <name or ID>, end

import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { localBridgeBuild } from "./bridge/bridge-build.ts";
import { BridgeClient } from "./bridge/bridge-client.ts";
import { FakeBridge } from "./bridge/fake-bridge.ts";
import { MouseWatch } from "./bridge/mouse-watch.ts";
import { UndoKeys } from "./bridge/undo-keys.ts";
import { findFile, fingerprint, userFolders } from "./media/fingerprint.ts";
import { loadIdentity, saveName, validName } from "./peer/identity.ts";
import { PeerLink, newInviteCode } from "./peer/peer-link.ts";
import { whereText } from "./presence.ts";
import { type Approval, Session } from "./session.ts";
import { findHostSession } from "./session-record.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";
import { CompanionWindow } from "./window/window-host.ts";

const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
export const DEFAULT_INBOX = join(homedir(), "ResolveCollab", "inbox");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    resume: { type: "boolean", default: false },
    name: { type: "string" },
    "no-window": { type: "boolean", default: false },
    inbox: { type: "string" },
    log: { type: "string" },
    fake: { type: "boolean", default: false },
    "force-tier": { type: "string" },
  },
});

const usage = () => {
  console.error("usage: node src/companion.ts [host [--resume] | join <invite-code>]   [--name you] [--no-window] [--fake] [--inbox dir] [--log file]");
  process.exit(2);
};
let [mode, codeArg] = positionals as [("host" | "join")?, string?];
if ((mode !== undefined && mode !== "host" && mode !== "join") || (mode === "join" && !codeArg) || (mode === "join" && values.resume)) usage();
if (mode === undefined && values["no-window"]) usage();
if (mode === "join" && !/^[0-9a-f]{32}$/.test(codeArg!)) {
  console.error("an invite code is 32 hex characters");
  process.exit(2);
}
let resume = values.resume;

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
const sessionsDir = join(home, "sessions");

// --- the window (SPEC §24) --------------------------------------------------------

const win = values["no-window"] ? undefined : new CompanionWindow(join(home, "window.json"));
const windowOpen = win?.start() ?? false;
if (win && !windowOpen) console.log("the window can't start here (is Electron installed?); the terminal keeps working");
let session: Session | undefined;
let peers: PeerLink | undefined;
let inviteCode = "";
let stopping = false;
const log = (message: string) => {
  console.log(`${new Date().toISOString().slice(11, 23)}  ${message}`);
  refresh();
};

// --- questions: in the terminal and the window, the first answer wins --------------

const terminal = createInterface({ input: process.stdin });
const CANCEL = "\u0000"; // given to a terminal question answered in the window
let answerLine: ((line: string) => void) | undefined;
const nextLine = () => new Promise<string>((resolve) => { answerLine = resolve; });
const cancelTerminal = () => {
  const answer = answerLine;
  answerLine = undefined;
  answer?.(CANCEL);
};

interface Waiting {
  kind: "card" | "review";
  card?: { who: string; color: string; text: string; actions: { label: string; value: string }[] };
  review?: { items: object[] };
  answer: (value: unknown) => void;
}
const waiting = new Map<string, Waiting>();
let nextQuestion = 1;

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

// Asks in the terminal (`inTerminal` returns undefined when cancelled) and in
// the window (`fromWindow` turns its answer into ours, or undefined if invalid).
function both<T>(entry: Omit<Waiting, "answer">, inTerminal: () => Promise<T | undefined>, fromWindow: (value: unknown) => T | undefined): Promise<T> {
  const id = `q${nextQuestion++}`;
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (value: T) => {
      if (done) return;
      done = true;
      waiting.delete(id);
      resolve(value);
      refresh();
    };
    waiting.set(id, { ...entry, answer: (raw) => {
      const value = fromWindow(raw);
      if (value === undefined) return;
      cancelTerminal();
      console.log("  (answered in the window)");
      finish(value);
    } });
    refresh();
    void inTerminal().then((v) => { if (v !== undefined) finish(v); });
  });
}

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

// One card in the window's Review screen per conflict (SPEC §9.3).
function reviewItem(c: Conflict) {
  const value = (v: unknown) => (typeof v === "string" ? v || "none" : JSON.stringify(v));
  if (c.kind === "clash") {
    const m = (v: unknown) => `\u201c${(v as { name: string }).name}\u201d (${(v as { color: string }).color})`;
    return { key: c.key, kind: "Two markers on one frame", what: `Frame ${(c.mine as { frame: number }).frame}`, mine: m(c.mine), theirs: m(c.theirs), mineLabel: "Keep yours", theirsLabel: "Keep theirs", mono: false };
  }
  if (c.kind === "field") return { key: c.key, kind: c.field ?? "Change", what: `${c.item} \u201c${c.label}\u201d`, mine: value(c.mine), theirs: value(c.theirs), mineLabel: "Keep yours", theirsLabel: "Keep theirs", mono: typeof c.mine === "number" };
  if (c.kind === "deleted-here") return { key: c.key, kind: "Deleted here, changed there", what: `${c.item} \u201c${c.label}\u201d`, mine: "Keep it deleted", theirs: "Bring back their version", mineLabel: "Yours", theirsLabel: "Theirs", mono: false };
  return { key: c.key, kind: "Changed here, deleted there", what: `${c.item} \u201c${c.label}\u201d`, mine: "Keep your version", theirs: "Delete it", mineLabel: "Yours", theirsLabel: "Theirs", mono: false };
}

// Keep mine / Keep theirs for each conflict, with "for all" (SPEC §9.3).
const ask = oneAtATime((conflicts: Conflict[]) => {
  log(`${conflicts.length} change(s) here conflict with the session. A backup of this project is saved before anything changes.`);
  return both<Map<string, Answer>>({ kind: "review", review: { items: conflicts.map(reviewItem) } }, async () => {
    const answers = new Map<string, Answer>();
    let all: Answer | undefined;
    for (const [i, c] of conflicts.entries()) {
      if (!all) {
        console.log(`  ${i + 1}/${conflicts.length}  ${describe(c)}`);
        for (;;) {
          console.log("        m = keep mine, t = keep theirs, M = mine for all the rest, T = theirs for all the rest");
          const line = (await nextLine()).trim();
          if (line === CANCEL) return undefined;
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
  }, (raw) => {
    const given = raw as Record<string, unknown>;
    if (typeof given !== "object" || given === null) return undefined;
    const answers = new Map<string, Answer>();
    for (const c of conflicts) {
      const v = given[c.key];
      if (v !== "mine" && v !== "theirs") return undefined;
      answers.set(c.key, v);
    }
    return answers;
  });
});

// A yes/no question (deleting a timeline for everyone, undoing over someone's change).
const confirm = oneAtATime((question: string) => both<boolean>(
  { kind: "card", card: { who: "", color: "#F5F5F7", text: question, actions: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] } },
  async () => {
    for (;;) {
      console.log(`  ${question}  y = yes, n = no`);
      const line = (await nextLine()).trim().toLowerCase();
      if (line === CANCEL) return undefined;
      if (line === "y" || line === "n") return line === "y";
    }
  },
  (v) => (v === "yes" ? true : v === "no" ? false : undefined),
));

// Asked when someone not let in before asks to join (SPEC §22.3).
const approve = oneAtATime((name: string, peer: string) => both<Approval>(
  { kind: "card", card: { who: name, color: "#F5F5F7", text: `(${peer}) wants to join this session.`, actions: [{ label: "Let in", value: "yes" }, { label: "Not now", value: "no" }, { label: "Block", value: "block" }] } },
  async () => {
    for (;;) {
      console.log(`  ${name} (${peer}) wants to join.  y = let in, n = not now, b = block this PC`);
      const line = (await nextLine()).trim().toLowerCase();
      if (line === CANCEL) return undefined;
      if (line === "y") return "yes";
      if (line === "n") return "no";
      if (line === "b") return "block";
    }
  },
  (v) => (v === "yes" || v === "no" || v === "block" ? v : undefined),
));

// Ctrl+Z / Ctrl+Shift+Z claim (SPEC §23.2); made early: the bridge's events use it.
const UNDO_PAGES = new Set(["media", "cut", "edit"]);
const keys = new UndoKeys();
let keysTimer: NodeJS.Timeout | undefined;

// --- the bridge, before anything else: the start screen shows its state ------------

const bridge = new BridgeClient({ logPath, inboxDir });
let openProject: { id: string; name: string } | undefined;
let resolveAnswers = false;
bridge.on("event", (e: { type?: unknown; project?: { id?: unknown; name?: unknown } | null }) => {
  if (e.type !== "mp.reset") return;
  openProject = e.project && typeof e.project.id === "string" ? { id: e.project.id, name: String(e.project.name ?? "") } : undefined;
  refresh();
});
bridge.on("attached", () => void bridge.send({ type: "mp.snapshot" }));
bridge.on("alive", (alive: boolean) => {
  resolveAnswers = alive;
  allowKeys();
  refresh();
});
let fake: FakeBridge | undefined;
bridge.start();
if (values.fake) {
  fake = new FakeBridge(logPath, inboxDir);
  fake.start();
}

const mouse = new MouseWatch(log);
mouse.start();

// --- what the window shows ----------------------------------------------------------

let startMessage = "";
let joining = false;
let lastSent = "";
function refresh(): void {
  if (!win?.open) return;
  const state = windowState();
  const text = JSON.stringify(state);
  if (text === lastSent) return;
  lastSent = text;
  win.show(state);
}
setInterval(refresh, 1000).unref(); // presence and sync state change on their own

function windowState(): object {
  const name = identity?.name ?? "";
  if (!session) {
    return {
      view: "start", name,
      start: { bridge: resolveAnswers, project: openProject?.name ?? "", canResume: !!openProject && !!findHostSession(sessionsDir, openProject.id), joining, message: startMessage },
    };
  }
  const s = session;
  const review = [...waiting].find(([, w]) => w.kind === "review");
  const people = s.people().map((p) => ({ id: p.id, name: p.name, color: p.color, online: p.online, you: p.id === peers!.id, where: whereText(p.presence) }));
  const colorOf = (id: string) => people.find((p) => p.id === id)?.color ?? "#F5F5F7";
  const urgent = [
    ...[...waiting].filter(([, w]) => w.kind === "card").map(([id, w]) => ({ id, ...w.card })),
    ...s.notices.list().map((n) => ({ id: `n${n.n}`, who: "", color: "#F5F5F7", text: n.plain, actions: [{ label: n.kind === "reapply" ? "Send mine again" : "Restore mine", value: "act" }, { label: "Dismiss", value: "dismiss" }] })),
    ...(!resolveAnswers ? [{ id: "p-bridge", who: "Resolve", color: "#F5F5F7", text: "isn't answering, so sync is paused. In Resolve, start Workspace \u203a Scripts \u203a ResolveCollab.", actions: [] }] : []),
    ...(resolveAnswers && s.begun && s.sync.paused ? [{ id: "p-project", who: "", color: "#F5F5F7", text: `Sync is paused: open \u201c${s.record?.projectName ?? "the session's project"}\u201d in Resolve.`, actions: [] }] : []),
    ...(s.begun && !s.inTouch ? [{ id: "p-host", who: "", color: "#F5F5F7", text: "The host is unreachable. Your changes are kept on this PC and merged when it's back.", actions: [] }] : []),
  ];
  const record = s.record;
  const members = record && mode === "host"
    ? [...record.members.map((m) => ({ id: m.key.slice(0, 8), name: m.name, online: people.some((p) => p.id === m.key.slice(0, 8) && p.online), blocked: false })),
      ...record.blocked.map((m) => ({ id: m.key.slice(0, 8), name: m.name, online: false, blocked: true }))]
    : people.filter((p) => !p.you).map((p) => ({ id: p.id, name: p.name, online: p.online, blocked: false }));
  const page = bridge.page ? bridge.page[0]!.toUpperCase() + bridge.page.slice(1) : "";
  return {
    view: review ? "review" : s.begun ? "session" : "start",
    name, project: record?.projectName ?? openProject?.name ?? "", role: mode === "host" ? "host" : "member", live: s.inTouch,
    code: mode === "host" ? inviteCode : "", following: s.following ?? null,
    people, lines: s.lines().map((l) => ({ ...l, color: colorOf(l.author) })), urgent, members,
    missing: s.begun ? [...s.sync.missing.values()].map((c) => ({ id: c.id, name: c.name })) : [],
    review: review ? { id: review[0], ...review[1].review } : null,
    status: !resolveAnswers ? "Waiting for Resolve" : `${s.inTouch ? "In sync" : "Offline"}${page ? ` · Resolve on the ${page} page` : ""} · Ctrl+Z undoes your own changes`,
    start: { bridge: resolveAnswers, project: openProject?.name ?? "", canResume: false, joining: true, message: startMessage || "Waiting for the host to let you in\u2026" },
  };
}

// --- this PC's name, and what to do: from the command line or the start screen -----

if (values.name !== undefined) {
  if (!validName(values.name)) {
    console.error("a name is 1 to 40 characters");
    process.exit(2);
  }
  saveName(home, values.name);
}
let identity = loadIdentity(home);

let chooseStart: ((choice: { mode: "host" | "join"; resume: boolean; code: string; name?: string }) => void) | undefined;
win?.on("action", (a: Record<string, unknown>) => void act(a));
win?.on("closed", () => { if (!stopping) void shutdown(); });

if (mode === undefined) {
  refresh();
  const choice = await new Promise<{ mode: "host" | "join"; resume: boolean; code: string; name?: string }>((resolve) => { chooseStart = resolve; });
  chooseStart = undefined;
  if (choice.name) saveName(home, choice.name);
  identity = loadIdentity(home);
  mode = choice.mode;
  resume = choice.resume;
  codeArg = choice.code;
  if (mode === "join") joining = true;
}
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

inviteCode = mode === "host" ? newInviteCode() : codeArg!;
peers = new PeerLink(inviteCode, { seed: identity.seed });
const link = peers;

session = new Session({
  role: mode === "host" ? "host" : "member",
  bridge,
  peers: link,
  storeDir: sessionsDir,
  backupsDir: join(home, "backups"),
  name: identity.name,
  resume,
  approve,
  onEnded: () => void shutdown(),
  onPeople: refresh,
  onLine: (line) => {
    if (line.kind === "chat" && line.author !== link.id) console.log(`${new Date().toISOString().slice(11, 23)}  ${line.name}: ${line.text}`);
    refresh();
  },
  ask,
  confirm,
  fingerprint,
  findFile: (file, dirs) => findFile(file, [...dirs, ...userFolders()]),
  log,
  ...(forceTier ? { forceTier: forceTier as 2 | 3 } : {}),
  userBusy: () => mouse.held,
  ...(values.fake ? {} : { bridgeBuild: localBridgeBuild() }),
});
const live = session;
// The bridge was attached before the session listened: its state again.
void bridge.send({ type: "mp.snapshot" });

// --- Ctrl+Z / Ctrl+Shift+Z (SPEC §23.2) ---------------------------------------------

function allowKeys(): void {
  keys.allow(resolveAnswers && !!session?.begun && UNDO_PAGES.has(bridge.page ?? ""));
}
bridge.on("page", allowKeys);
keysTimer = setInterval(allowKeys, 1000); // the session can begin after the page was last told
let undoing = false;
async function undoKey(redo: boolean): Promise<void> {
  if (undoing) return; // one at a time: a question may be waiting
  undoing = true;
  try {
    log(await (redo ? live.redo() : live.undo()));
  } finally {
    undoing = false;
  }
}
keys.on("undo", () => void undoKey(false));
keys.on("redo", () => void undoKey(true));
keys.on("taken", () => log("another program has claimed Ctrl+Z, so it stays Resolve's; type undo / redo here instead"));
keys.on("gone", () => log("can't claim Ctrl+Z any more, so it's Resolve's again; type undo / redo here instead"));
if (!values.fake) keys.start();

// --- what the person does: in the window ---------------------------------------------

async function act(a: Record<string, unknown>): Promise<void> {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  switch (a.type) {
    case "start": {
      const m = a.mode;
      const name = text(a.name).trim();
      if (!chooseStart || (m !== "host" && m !== "resume" && m !== "join")) return;
      if (name && !validName(name)) return;
      if (m === "join" && !/^[0-9a-f]{32}$/.test(text(a.code))) return;
      chooseStart({ mode: m === "join" ? "join" : "host", resume: m === "resume", code: text(a.code), ...(name ? { name } : {}) });
      return;
    }
    case "close":
      return shutdown();
    case "window-log":
      console.log(`${new Date().toISOString().slice(11, 23)}  window: ${text(a.text).slice(0, 500)}`);
      return;
  }
  if (!session) return;
  const s = session;
  switch (a.type) {
    case "chat":
      if (text(a.text).trim()) s.chat(text(a.text));
      return;
    case "follow":
      s.follow(typeof a.id === "string" ? a.id : undefined);
      refresh();
      return;
    case "jump": {
      const line = s.lines().find((l) => l.id === a.line);
      if (line) s.jumpTo(line);
      return;
    }
    case "jump-tc":
      if (/^\d\d:\d\d:\d\d[:;]\d\d$/.test(text(a.timecode))) s.jumpToTimecode(text(a.timecode));
      return;
    case "answer": {
      const id = text(a.id);
      const notice = /^n(\d+)$/.exec(id);
      if (notice) {
        const n = Number(notice[1]);
        const kind = s.notices.list().find((x) => x.n === n)?.kind;
        if (a.value === "act") log(kind === "restore" ? s.restore(n) : s.reapply(n));
        else if (a.value === "dismiss" && kind) s.notices.take(n, kind);
        refresh();
        return;
      }
      waiting.get(id)?.answer(a.value);
      return;
    }
    case "remove":
      if (mode === "host") log(s.remove(text(a.name)));
      return;
    case "unblock":
      if (mode === "host") log(s.unblock(text(a.name)));
      return;
    case "end":
      if (mode === "host") s.endForGood();
      return;
    case "locate":
      if (text(a.clip) && text(a.path)) log(await s.sync.locate(text(a.clip), text(a.path)));
      return;
  }
}

// --- and in the terminal ----------------------------------------------------------------

terminal.on("line", async (line) => {
  if (answerLine) {
    const answer = answerLine;
    answerLine = undefined;
    answer(line);
    return;
  }
  const s = live;
  const [command, ...rest] = line.trim().split(/\s+/);
  if (command === "missing") {
    const missing = [...s.sync.missing.values()];
    if (!missing.length) log("no missing media");
    for (const clip of missing) log(`missing: ${clip.id.slice(0, 8)}  "${clip.name}"`);
  } else if (command === "locate" && rest.length >= 2) {
    // The path may contain spaces; quotes from Explorer's "Copy as path" are dropped.
    log(await s.sync.locate(rest[0]!, rest.slice(1).join(" ").replace(/^"(.*)"$/, "$1")));
  } else if (command === "chat" && rest.length) {
    s.chat(rest.join(" "));
  } else if (command === "undo") {
    log(await s.undo());
  } else if (command === "redo") {
    log(await s.redo());
  } else if (command === "restore" && /^\d+$/.test(rest[0] ?? "")) {
    log(s.restore(Number(rest[0])));
  } else if (command === "reapply" && /^\d+$/.test(rest[0] ?? "")) {
    log(s.reapply(Number(rest[0])));
  } else if (command === "members" && mode === "host") {
    const list = s.memberList();
    log(list.length ? `members:\n    ${list.join("\n    ")}` : "nobody has joined yet");
  } else if (command === "remove" && mode === "host" && rest.length) {
    log(s.remove(rest.join(" ")));
  } else if (command === "unblock" && mode === "host" && rest.length) {
    log(s.unblock(rest.join(" ")));
  } else if (command === "end" && mode === "host") {
    if (await confirm("End this session for good? It can't be resumed afterwards.")) s.endForGood();
  } else if (command) {
    const common = "chat <message> | missing | locate <clip> <path> | undo | redo | reapply <n> | restore <n>";
    log(mode === "host" ? `commands: ${common} | members | remove <name> | unblock <name> | end` : `commands: ${common}`);
  }
});

// Said before the peer link starts: the host can answer while it's still starting.
log(`you are ${identity.name} (${link.id})`);
log(`bridge inbox: ${inboxDir}`);
if (mode === "join") log("looking for the host ...");
await link.start();
if (mode === "host") {
  log(`invite code: ${inviteCode}`);
  log("Share it with the people joining. It works until you close this companion; next time, host --resume gives a new one.");
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await session?.close();
  mouse.stop();
  clearInterval(keysTimer);
  keys.stop();
  win?.stop();
  bridge.stop();
  fake?.stop();
  await peers?.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
