// Export diagnostics (SPEC §14): the companion's logs, versions and what the
// bridge reported, zipped into Downloads for whoever is debugging. Logs hold
// clip and file names, never media.

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findFfmpeg } from "./media/proxy.ts";
import { APP_VERSION } from "./version.ts";

const run = promisify(execFile);

export async function diagnostics(o: { logsDir: string; resolve: unknown; bridgeExpected: string; bridgeRunning: string | undefined; extra?: Record<string, unknown> }): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const work = mkdtempSync(join(tmpdir(), "rc-diag-"));
  const box = join(work, "ResolveCollab-diagnostics");
  mkdirSync(box);
  if (existsSync(o.logsDir)) cpSync(o.logsDir, join(box, "logs"), { recursive: true });
  writeFileSync(join(box, "info.json"), JSON.stringify({
    resolveCollab: APP_VERSION, at: new Date().toISOString(), windows: release(), node: process.versions.node, electron: process.versions.electron ?? null,
    resolve: o.resolve ?? null, bridge: { expected: o.bridgeExpected, running: o.bridgeRunning ?? null }, ffmpeg: findFfmpeg() ?? null, ...o.extra,
  }, null, 2));
  const out = join(homedir(), "Downloads", `ResolveCollab-diagnostics-${stamp}.zip`);
  mkdirSync(join(homedir(), "Downloads"), { recursive: true });
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath $env:RC_SRC -DestinationPath $env:RC_DST -Force"],
    { env: { ...process.env, RC_SRC: box, RC_DST: out }, windowsHide: true, timeout: 120_000 });
  rmSync(work, { recursive: true, force: true });
  return out;
}
