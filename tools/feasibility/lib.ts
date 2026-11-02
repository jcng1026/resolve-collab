// Pure helpers for the feasibility tools (prepare.ts, collect.ts).

import { homedir } from "node:os";
import { join } from "node:path";

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

export const STATE_DIR = join(LOCALAPPDATA, "ResolveCollab", "feasibility");
export const RESOLVE_SUPPORT = join(APPDATA, "Blackmagic Design", "DaVinci Resolve", "Support");
export const SCRIPTS_UTILITY = join(RESOLVE_SUPPORT, "Fusion", "Scripts", "Utility");
export const FUSION_PREFS = join(RESOLVE_SUPPORT, "Fusion", "Profiles", "Default", "Fusion.prefs");

const KEY_PATTERN = /\bRCFeas(\w+)\s*=\s*"([0-9a-fA-F]*)"/g;

// Returns the RCFeas* keys in a Fusion.prefs text, still hex-encoded.
export function extractRcKeys(prefsText: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const match of prefsText.matchAll(KEY_PATTERN)) {
    keys.set(match[1]!, match[2]!);
  }
  return keys;
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
