// Puts bridge/ResolveCollab.lua into Resolve's Scripts > Utility folder, with
// the inbox path and the build stamped in (SPEC §26.1: the installed app does
// it at every start; from the repo, tools/install-bridge.ts). Not under
// %LOCALAPPDATA%: a packaged app's writes there are invisible to Resolve.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_PLACEHOLDER, bridgeBuild } from "./bridge-build.ts";

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
export const SCRIPTS = join(APPDATA, "Blackmagic Design", "DaVinci Resolve", "Support", "Fusion", "Scripts", "Utility");
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "ResolveCollab.lua");

// "new": Resolve lists it only after a restart; "updated": start it again in
// Resolve; "same": nothing changed.
export function installBridge(inboxDir: string): { state: "new" | "updated" | "same"; path: string; build: string } {
  const inbox = resolve(inboxDir);
  if (inbox.includes("]]")) throw new Error(`the inbox path can't contain "]]": ${inbox}`);
  // Folder names in the inbox are up to ~216 characters: Windows' 260-character limit.
  if (inbox.length > 40) throw new Error(`the inbox path is too long for Windows' 260-character limit: ${inbox}`);
  const source = readFileSync(SOURCE, "utf8");
  if (!source.includes("__INBOX__") || !source.includes(BUILD_PLACEHOLDER)) throw new Error("the bridge file is missing its placeholders");
  const build = bridgeBuild(source);
  const text = source.replaceAll("__INBOX__", inbox).replaceAll(BUILD_PLACEHOLDER, build);
  const path = join(SCRIPTS, "ResolveCollab.lua");
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  mkdirSync(inbox, { recursive: true });
  if (before === text) return { state: "same", path, build };
  mkdirSync(SCRIPTS, { recursive: true });
  writeFileSync(path, text);
  return { state: before === undefined ? "new" : "updated", path, build };
}
