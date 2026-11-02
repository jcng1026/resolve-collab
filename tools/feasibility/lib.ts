// Pure helpers for the feasibility tools (prepare.ts, collect.ts).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

// Not under %LOCALAPPDATA%: when these tools run from a packaged (MSIX) app,
// Windows redirects that folder into a private copy Resolve cannot see.
// `local/` is gitignored.
export const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "local", "feasibility");
export const RESOLVE_SUPPORT = join(APPDATA, "Blackmagic Design", "DaVinci Resolve", "Support");
export const SCRIPTS_UTILITY = join(RESOLVE_SUPPORT, "Fusion", "Scripts", "Utility");
// The probe reports through errors raised in fusion:Execute, which Resolve
// writes here immediately (docs/feasibility/findings-2026-11-02.md).
export const RESOLVE_DEBUG_LOG = join(RESOLVE_SUPPORT, "logs", "ResolveDebug.txt");

const LINE_PATTERN = /RCFEAS\|(\w+)\|([0-9a-fA-F]*)/;

export interface ProbeMessage {
  key: string;
  hex: string;
}

// Parses one log line, e.g.
// `... | Fusion | ERROR | ... | [string "???"]:1: RCFEAS|Stage|706f6c6c`.
export function parseLogLine(line: string): ProbeMessage | null {
  const match = LINE_PATTERN.exec(line);
  return match ? { key: match[1]!, hex: match[2]! } : null;
}

export function hexToUtf8(hex: string): string {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`not a hex string (length ${hex.length})`);
  }
  return Buffer.from(hex, "hex").toString("utf8");
}

// Joins RCFeasResult1..N in order; null while any chunk is missing.
export function joinResultChunks(keys: Map<string, string>): string | null {
  const countHex = keys.get("ResultCount");
  if (countHex === undefined) return null;
  const count = Number(hexToUtf8(countHex));
  let hex = "";
  for (let i = 1; i <= count; i++) {
    const chunk = keys.get(`Result${i}`);
    if (chunk === undefined) return null;
    hex += chunk;
  }
  return hexToUtf8(hex);
}

export interface Summary {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { count: sorted.length, min: sorted[0]!, median: at(0.5), p95: at(0.95), max: sorted.at(-1)! };
}

// The Lua script embeds the state dir in a [[long string]], which "]]" would end.
export function stampStateDir(luaSource: string, stateDir: string): string {
  if (stateDir.includes("]]")) throw new Error(`state dir cannot contain "]]": ${stateDir}`);
  if (!luaSource.includes("__STATE_DIR__")) throw new Error("placeholder __STATE_DIR__ not found");
  return luaSource.replaceAll("__STATE_DIR__", stateDir);
}
