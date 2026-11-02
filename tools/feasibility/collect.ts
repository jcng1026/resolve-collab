// Watches Fusion.prefs while the Lua probe runs, measures the request → echo
// round trip on Node's clock (F1/F2), and saves the probe's results to
// docs/feasibility/. Run with: node tools/feasibility/collect.ts

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toLuaLiteral } from "../../src/bridge-protocol/lua-literal.ts";
import { FUSION_PREFS, STATE_DIR, extractRcKeys, hexToUtf8, joinResultChunks, summarize } from "./lib.ts";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "feasibility");
const POLL_MS = 25;
const REQUEST_EVERY_MS = 500;
const TIMEOUT_MS = 15 * 60 * 1000;

const REQUEST = join(STATE_DIR, "request.lua");

function readKeys(): Map<string, string> {
  try {
    return extractRcKeys(readFileSync(FUSION_PREFS, "utf8"));
  } catch {
    return new Map(); // Resolve may be mid-write; try again next poll.
  }
}

function decode(keys: Map<string, string>, key: string): string | undefined {
  const value = keys.get(key);
  return value === undefined ? undefined : hexToUtf8(value);
}

// Write-then-rename so the probe never loads a half-written file.
function sendRequest(n: number): void {
  writeFileSync(`${REQUEST}.tmp`, `return ${toLuaLiteral({ n })}\n`);
  renameSync(`${REQUEST}.tmp`, REQUEST);
}

const initial = readKeys();
const pythonAtStart = initial.has("Python");
let lastStage = decode(initial, "Stage");
let sawRunning = false;
let nextN = 1;
let lastSent = 0;
let lastEcho = decode(initial, "Echo");
const sentAt = new Map<number, number>();
const rtts: number[] = [];
const stages: { stage: string; at: number }[] = [];
const started = Date.now();

console.log("Waiting for the probe. In Resolve: Workspace > Scripts > ResolveCollab_Feasibility");
console.log("Also run Workspace > Scripts > ResolveCollab_PythonProbe if it is listed.");

const timer = setInterval(() => {
  const now = Date.now();
  if (now - started > TIMEOUT_MS) {
    console.error("Timed out after 15 minutes without a finished result.");
    clearInterval(timer);
    process.exitCode = 1;
    return;
  }
  const keys = readKeys();
  const stage = decode(keys, "Stage");
  if (stage !== undefined && stage !== lastStage) {
    lastStage = stage;
    stages.push({ stage, at: now - started });
    if (stage !== "done") sawRunning = true;
    console.log(`  ${((now - started) / 1000).toFixed(1).padStart(6)} s  ${stage}`);
  }

  if (stage === "pollLoop" && now - lastSent >= REQUEST_EVERY_MS) {
    sentAt.set(nextN, now);
    sendRequest(nextN++);
    lastSent = now;
  }
  const echo = decode(keys, "Echo");
  if (echo !== undefined && echo !== lastEcho) {
    lastEcho = echo;
    const sent = sentAt.get(Number(echo));
    if (sent !== undefined) rtts.push(now - sent);
  }

  if (sawRunning && stage === "done") {
    const fatal = decode(keys, "Fatal");
    if (fatal !== undefined && !keys.has("ResultCount")) {
      clearInterval(timer);
      save({ fatal, globals: decode(keys, "Globals") }, keys);
      return;
    }
    const text = joinResultChunks(keys);
    if (text === null) return; // chunks not all flushed yet
    clearInterval(timer);
    save(JSON.parse(text), keys);
  }
}, POLL_MS);

function save(probe: unknown, keys: Map<string, string>): void {
  const report = {
    collectedAt: new Date().toISOString(),
    roundTripMs: summarize(rtts),
    requestsSent: nextN - 1,
    echoesSeen: rtts.length,
    stages,
    python: { listedAndRan: keys.has("Python") && !pythonAtStart, seenBeforeRun: pythonAtStart },
    probe,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `results-${report.collectedAt.slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSaved ${file}`);
  console.log(`Round trip (ms): ${JSON.stringify(report.roundTripMs)}`);
}
