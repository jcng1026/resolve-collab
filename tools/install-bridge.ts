// Installs bridge/ResolveCollab.lua into Resolve's Scripts > Utility folder
// with the inbox path filled in (the companion also does this at start). Run with:
//   node tools/install-bridge.ts [inbox-dir]
// Resolve lists new scripts after a restart; updating an installed one does not need it.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installBridge } from "../src/bridge/install.ts";

// Not under %LOCALAPPDATA%: a packaged app's writes there are invisible to Resolve.
const inbox = resolve(process.argv[2] ?? join(homedir(), "ResolveCollab", "inbox"));
const { path, build } = installBridge(inbox);
console.log(`Installed ${path}`);
console.log(`Inbox: ${inbox}`);
console.log(`Build: ${build}`);
