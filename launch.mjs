// Starts ResolveCollab from the Start menu (SPEC §12.2). Electron, run as
// Node, runs the companion with no console window; this launcher then quits.
// If a companion is already running, nothing new starts (two would both
// talk to Resolve's bridge).

import { app } from "electron";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function running() {
  try {
    const pid = Number(readFileSync(join(homedir(), "ResolveCollab", "companion.pid"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws if there's no such process
    return true;
  } catch {
    return false;
  }
}

if (!running()) {
  const child = spawn(process.execPath, [join(HERE, "src", "companion.ts")], {
    cwd: HERE, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
}
app.quit();
