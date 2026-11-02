// File fingerprints (SPEC §10.1, §19.2) and looking for a local copy of a
// file another peer has (§19.6). Files are matched by name, size and a
// partial hash, never by folder, since paths differ between PCs.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Fingerprint } from "../sync/media-pool.ts";

const SAMPLE = 1024 * 1024;

// SHA-256 over the size and the first, middle and last 1 MB.
export async function fingerprint(path: string): Promise<Fingerprint | null> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  const hash = createHash("sha256").update(`${size}\n`);
  const file = await open(path, "r");
  try {
    const offsets = size <= 3 * SAMPLE ? [0] : [0, Math.floor(size / 2 - SAMPLE / 2), size - SAMPLE];
    for (const offset of offsets) {
      const length = Math.min(size <= 3 * SAMPLE ? size : SAMPLE, size - offset);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, offset);
      hash.update(buffer);
    }
  } finally {
    await file.close();
  }
  return { name: basename(path), size, hash: hash.digest("hex") };
}

// A bare file name: no folder parts, so joining it to a folder stays inside.
export function isPlainFileName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/:]/.test(name);
}

// Standard folders searched as well as the given ones.
export function userFolders(): string[] {
  return ["Downloads", "Videos", "Desktop", "Documents"].map((name) => join(homedir(), name));
}

// Looks for a file with the same name in each folder and returns the first
// whose fingerprint matches.
export async function findFile(file: Fingerprint, dirs: string[]): Promise<string | null> {
  if (!isPlainFileName(file.name)) return null; // names come from peers
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, file.name);
    if (!existsSync(candidate)) continue;
    const found = await fingerprint(candidate);
    if (found && found.size === file.size && found.hash === file.hash) return candidate;
  }
  return null;
}
