// Installs bridge/ResolveCollab.lua into Resolve's Scripts > Utility folder
// with the inbox path filled in. Run with:
//   node tools/install-bridge.ts [inbox-dir]
// Resolve lists new scripts after a restart; updating an installed one does not need it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_PLACEHOLDER, bridgeBuild } from "../src/bridge/bridge-build.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const SCRIPTS = join(APPDATA, "Blackmagic Design", "DaVinci Resolve", "Support", "Fusion", "Scripts", "Utility");
// Not under %LOCALAPPDATA%: a packaged app's writes there are invisible to Resolve.
const inbox = resolve(process.argv[2] ?? join(homedir(), "ResolveCollab", "inbox"));

if (inbox.includes("]]")) throw new Error(`inbox path cannot contain "]]": ${inbox}`);
// Folder names are up to ~216 characters, so the inbox path must stay short.
if (inbox.length > 40) throw new Error(`inbox path too long for Windows' 260-character limit: ${inbox}`);

const source = readFileSync(join(HERE, "..", "bridge", "ResolveCollab.lua"), "utf8");
if (!source.includes("__INBOX__")) throw new Error("placeholder __INBOX__ not found");
if (!source.includes(BUILD_PLACEHOLDER)) throw new Error(`placeholder ${BUILD_PLACEHOLDER} not found`);
// The hash of the source as it is in the repo, so the companion can compare.
const build = bridgeBuild(source);
mkdirSync(inbox, { recursive: true });
mkdirSync(SCRIPTS, { recursive: true });
writeFileSync(join(SCRIPTS, "ResolveCollab.lua"), source.replaceAll("__INBOX__", inbox).replaceAll(BUILD_PLACEHOLDER, build));
console.log(`Installed ${join(SCRIPTS, "ResolveCollab.lua")}`);
console.log(`Inbox: ${inbox}`);
console.log(`Build: ${build}`);
