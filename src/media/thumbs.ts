// Thumbnails for the Media grid (touch-ups, 2026-11-13): a clip's first frame
// as a small JPEG, and its length, made with the bundled ffmpeg from a file
// on this PC (its original or its proxy), cached by the clip's fingerprint.
// A clip not on this PC gets its thumbnail from a PC that has it (manager.ts),
// checked here before it's kept.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { classify, findFfmpeg } from "./proxy.ts";

const run = promisify(execFile);
export const THUMB_MAX = 64 * 1024; // a thumbnail from another PC is at most this

export interface Thumb { hash: string; duration: number } // `hash`: the clip's fingerprint, the cache file's name

const isHash = (h: string) => /^[0-9a-f]{64}$/.test(h);

export class ThumbCache {
  readonly dir: string;
  private readonly making = new Map<string, Promise<Thumb | undefined>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private jpg(hash: string): string { return join(this.dir, `${hash}.jpg`); }
  private info(hash: string): string { return join(this.dir, `${hash}.json`); }

  // Already here?
  get(hash: string): Thumb | undefined {
    if (!isHash(hash) || !existsSync(this.jpg(hash))) return undefined;
    let duration = 0;
    try { duration = Number(JSON.parse(readFileSync(this.info(hash), "utf8")).duration) || 0; } catch { /* no length known */ }
    return { hash, duration };
  }

  // Made from a file on this PC: its first frame, 320 wide. Audio files get none.
  make(hash: string, src: string): Promise<Thumb | undefined> {
    if (!isHash(hash)) return Promise.resolve(undefined);
    const have = this.get(hash);
    if (have) return Promise.resolve(have);
    let job = this.making.get(hash);
    if (!job) {
      job = this.create(hash, src).catch(() => undefined).finally(() => this.making.delete(hash));
      this.making.set(hash, job);
    }
    return job;
  }

  private async create(hash: string, src: string): Promise<Thumb | undefined> {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return undefined;
    const what = await classify(src, ffmpeg);
    if (what.kind !== "video" && what.kind !== "still") return undefined;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.jpg(hash)}.making.jpg`;
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", tmp], { windowsHide: true, timeout: 60_000 });
    await rename(tmp, this.jpg(hash));
    const duration = what.kind === "video" ? what.duration : 0;
    await writeFile(this.info(hash), JSON.stringify({ duration }));
    return { hash, duration };
  }

  // A thumbnail another PC sent: kept only if it's a JPEG of at most THUMB_MAX bytes.
  async put(hash: string, jpg: Buffer, duration: number): Promise<Thumb | undefined> {
    if (!isHash(hash) || jpg.length < 4 || jpg.length > THUMB_MAX || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[2] !== 0xff) return undefined;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.jpg(hash), jpg);
    const d = Number.isFinite(duration) && duration >= 0 && duration < 1e7 ? duration : 0;
    await writeFile(this.info(hash), JSON.stringify({ duration: d }));
    return { hash, duration: d };
  }

  // The JPEG to send another PC.
  async read(hash: string): Promise<Buffer | undefined> {
    if (!this.get(hash)) return undefined;
    const b = await readFile(this.jpg(hash));
    return b.length <= THUMB_MAX ? b : undefined;
  }

  async drop(hash: string): Promise<void> {
    if (!isHash(hash)) return;
    await rm(this.jpg(hash), { force: true });
    await rm(this.info(hash), { force: true });
  }
}
