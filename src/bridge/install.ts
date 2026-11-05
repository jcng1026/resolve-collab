// Puts the bridge script into Resolve's Scripts > Utility folder with this
// PC's inbox filled in (SPEC §12.2). The companion does it at start, so an
// installed app keeps Resolve's bridge up to date by itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_PLACEHOLDER, bridgeBuild } from "./bridge-build.ts";

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
export const SCRIPTS = join(APPDATA, "Blackmagic Design", "DaVinci Resolve", "Support", "Fusion", "Scripts", "Utility");
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "ResolveCollab.lua");

// Writes it if it isn't there or differs; says whether it changed.
export function installBridge(inbox: string): { path: string; build: string; changed: boolean } {
  if (inbox.includes("]]")) throw new Error(`inbox path cannot contain "]]": ${inbox}`);
  // Folder names are up to ~216 characters, so the inbox path must stay short.
  if (inbox.length > 40) throw new Error(`inbox path too long for Windows' 260-character limit: ${inbox}`);
  const source = readFileSync(SOURCE, "utf8");
  if (!source.includes("__INBOX__") || !source.includes(BUILD_PLACEHOLDER)) throw new Error("the bridge script's placeholders are missing");
  const build = bridgeBuild(source);
  const text = source.replaceAll("__INBOX__", inbox).replaceAll(BUILD_PLACEHOLDER, build);
  const path = join(SCRIPTS, "ResolveCollab.lua");
  mkdirSync(inbox, { recursive: true });
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== text;
  if (changed) {
    mkdirSync(SCRIPTS, { recursive: true });
    writeFileSync(path, text);
  }
  return { path, build, changed };
}
