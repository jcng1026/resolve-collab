// Follows Resolve's debug log while the Lua probe runs, measures the
// request → echo round trip on Node's clock (F1/F2), and saves the probe's
// results to docs/feasibility/. Run with: node tools/feasibility/collect.ts
// Add `--name <tag>` to save as results-<date>-<tag>.json (other probes).

import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toLuaLiteral } from "../../src/bridge-protocol/lua-literal.ts";
import { RESOLVE_DEBUG_LOG, STATE_DIR, hexToUtf8, joinResultChunks, parseLogLine, summarize } from "./lib.ts";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "feasibility");
const POLL_MS = 25;
const REQUEST_EVERY_MS = 500;
const TIMEOUT_MS = 15 * 60 * 1000;

const REQUEST = join(STATE_DIR, "request.lua");
const nameAt = process.argv.indexOf("--name");
const TAG = nameAt > 0 ? process.argv[nameAt + 1] : undefined;
if (TAG !== undefined && !/^[a-z0-9-]+$/.test(TAG)) throw new Error(`--name must be lowercase letters, digits or dashes: ${TAG}`);

// Reads only what was appended since the last poll. The log is replaced when
// Resolve restarts, so a shrinking file starts over from the beginning.
let offset = statSync(RESOLVE_DEBUG_LOG).size;
let partial = "";

function newLines(): string[] {
  const size = statSync(RESOLVE_DEBUG_LOG).size;
  if (size < offset) offset = 0;
  if (size === offset) return [];
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(RESOLVE_DEBUG_LOG, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  offset = size;
  const lines = (partial + buffer.toString("utf8")).split(/\r?\n/);
  partial = lines.pop() ?? "";
  return lines;
}

// Write-then-rename so the probe never loads a half-written file.
function sendRequest(n: number): void {
  writeFileSync(`${REQUEST}.tmp`, `return ${toLuaLiteral({ n })}\n`);
  renameSync(`${REQUEST}.tmp`, REQUEST);
}

const keys = new Map<string, string>();
let stage: string | undefined;
let nextN = 1;
let lastSent = 0;
const sentAt = new Map<number, number>();
const rtts: number[] = [];
const stages: { stage: string; at: number }[] = [];
const started = Date.now();

console.log(`Waiting for the probe. In Resolve: Workspace > Scripts > ${TAG ? "the probe to run" : "ResolveCollab_Feasibility"}`);

const timer = setInterval(() => {
  const now = Date.now();
  if (now - started > TIMEOUT_MS) {
    console.error("Timed out after 15 minutes without a finished result.");
    clearInterval(timer);
    process.exitCode = 1;
    return;
  }

  for (const line of newLines()) {
    const message = parseLogLine(line);
    if (!message) continue;
    keys.set(message.key, message.hex);
    if (message.key === "Stage") {
      stage = hexToUtf8(message.hex);
      stages.push({ stage, at: now - started });
      console.log(`  ${((now - started) / 1000).toFixed(1).padStart(6)} s  ${stage}`);
    } else if (message.key === "Echo") {
      const sent = sentAt.get(Number(hexToUtf8(message.hex)));
      if (sent !== undefined) rtts.push(now - sent);
    }
  }

  if (stage === "pollLoop" && now - lastSent >= REQUEST_EVERY_MS) {
    sentAt.set(nextN, now);
    sendRequest(nextN++);
    lastSent = now;
  }

  if (stage === "done") {
    const fatal = keys.get("Fatal");
    if (fatal !== undefined && !keys.has("ResultCount")) {
      clearInterval(timer);
      save({ fatal: hexToUtf8(fatal) });
      return;
    }
    const text = joinResultChunks(keys);
    if (text === null) return; // chunks not all read yet
    clearInterval(timer);
    save(JSON.parse(text));
  }
}, POLL_MS);

function save(probe: unknown): void {
  const report = {
    collectedAt: new Date().toISOString(),
    roundTripMs: summarize(rtts),
    requestsSent: nextN - 1,
    echoesSeen: rtts.length,
    stages,
    probe,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `results-${report.collectedAt.slice(0, 10)}${TAG ? `-${TAG}` : ""}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSaved ${file}`);
  console.log(`Round trip (ms): ${JSON.stringify(report.roundTripMs)}`);
}
