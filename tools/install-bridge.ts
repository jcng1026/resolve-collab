// Installs bridge/ResolveCollab.lua into Resolve's Scripts > Utility folder
// with the inbox path filled in (the installed app does this by itself). Run with:
//   node tools/install-bridge.ts [inbox-dir]
// Resolve lists new scripts after a restart; updating an installed one does not need it.

import { homedir } from "node:os";
import { join } from "node:path";
import { installBridge } from "../src/bridge/install.ts";

const result = installBridge(process.argv[2] ?? join(homedir(), "ResolveCollab", "inbox"));
console.log(`${result.state === "same" ? "Already installed" : "Installed"} ${result.path}`);
console.log(`Build: ${result.build}`);
