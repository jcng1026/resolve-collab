// The companion's log (SPEC §26.1): what it prints also goes to a file per
// day, companion-YYYY-MM-DD.log, kept 14 days. It holds what the terminal
// shows (clip and file names, peer IDs), never media.

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

const KEEP_DAYS = 14;

export function logToFiles(dir: string, now: () => Date = () => new Date()): void {
  mkdirSync(dir, { recursive: true });
  const cutoff = now().getTime() - KEEP_DAYS * 24 * 3600_000;
  for (const name of readdirSync(dir)) {
    if (!/^companion-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    try { if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name)); } catch { /* in use or gone */ }
  }
  const write = (args: unknown[]) => {
    const d = now();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try { appendFileSync(join(dir, `companion-${day}.log`), `${format(...args)}\n`); } catch { /* a full or read-only disk: the app carries on */ }
  };
  for (const level of ["log", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(args);
      original(...args);
    };
  }
}
