// What the Start-menu shortcut runs (SPEC §26.1): Electron starts the
// companion with Electron's own Node, with no console window, and quits. If a
// companion is already running, the new one brings its window forward and
// stops (src/one-copy.ts).

import { app } from "electron";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
app.setPath("userData", join(tmpdir(), "resolvecollab-launcher")); // not the window's: it holds that cache
const child = spawn(process.execPath, [join(HERE, "src", "companion.ts"), "--app"], {
  cwd: HERE, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true,
});
child.unref();
app.quit();
