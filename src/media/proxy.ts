// Proxies (SPEC §10.3, §25.1, §25.3): made by a PC that has the original,
// when someone first needs one, and kept under the original's fingerprint for
// the next. Audio files and still images are sent as they are; a file ffprobe
// can't read gets no proxy.

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const STILLS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".exr", ".dpx", ".tga", ".psd", ".heic"]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ffmpeg: $FFMPEG; then the LGPL build that comes with the app (SPEC §26.1:
// the installed app's "ffmpeg" folder, the repo's "vendorfmpeg"); then
// winget's shim or package folder; then PATH.
export function findFfmpeg(): string | undefined {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  for (const dir of [join(ROOT, "ffmpeg"), join(ROOT, "vendor", "ffmpeg")]) {
    if (existsSync(join(dir, "ffmpeg.exe"))) return join(dir, "ffmpeg.exe");
  }
  const winget = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet");
  const link = join(winget, "Links", "ffmpeg.exe");
  if (existsSync(link)) return link;
  const packages = join(winget, "Packages");
  for (const pkg of existsSync(packages) ? readdirSync(packages) : []) {
    if (!/ffmpeg/i.test(pkg)) continue;
    for (const build of readdirSync(join(packages, pkg))) {
      const exe = join(packages, pkg, build, "bin", "ffmpeg.exe");
      if (existsSync(exe)) return exe;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(";")) {
    const exe = join(dir, "ffmpeg.exe");
    if (dir && existsSync(exe)) return exe;
  }
  return undefined;
}

const probeOf = (ffmpeg: string) => join(dirname(ffmpeg), `ffprobe${extname(ffmpeg)}`);

// The H.264 encoder to use: x264 where this ffmpeg has it (a GPL build), else
// Windows' own (h264_mf, in the LGPL build), which takes a bitrate, not a quality.
const encoders = new Map<string, Promise<string[]>>();
async function h264Args(ffmpeg: string, src: string): Promise<string[]> {
  if (!encoders.has(ffmpeg)) encoders.set(ffmpeg, run(ffmpeg, ["-hide_banner", "-encoders"], { windowsHide: true, timeout: 30_000 }).then((r) => {
    if (/\blibx264\b/.test(r.stdout)) return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
    if (/\bh264_mf\b/.test(r.stdout)) return ["-c:v", "h264_mf", "-rate_control", "u_vbr", "-pix_fmt", "nv12"]; // u_vbr: the bitrate is kept
    throw new Error("this ffmpeg has no H.264 encoder");
  }));
  const args = await encoders.get(ffmpeg)!;
  if (!args.includes("h264_mf")) return args;
  // A bitrate for the proxy's height (half the original's, at most 1080).
  const height = await run(probeOf(ffmpeg), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", src], { windowsHide: true, timeout: 30_000 })
    .then((r) => Math.min(1080, Math.floor(Number.parseInt(r.stdout, 10) / 4) * 2) || 1080, () => 1080); // ffmpeg 9 prints it twice
  return [...args, "-b:v", height <= 540 ? "2M" : height <= 720 ? "3M" : "5M"];
}

export type MediaKind = { kind: "video"; duration: number } | { kind: "audio" } | { kind: "still" } | { kind: "unreadable" };

// What a file is, by ffprobe (stills by their extension: ffprobe reads them as one-frame video).
export async function classify(path: string, ffmpeg = findFfmpeg()): Promise<MediaKind> {
  if (STILLS.has(extname(path).toLowerCase())) return { kind: "still" };
  if (!ffmpeg) return { kind: "unreadable" };
  try {
    const { stdout } = await run(probeOf(ffmpeg), ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", path], { windowsHide: true, timeout: 30_000 });
    const j = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    const types = new Set((j.streams ?? []).map((s) => s.codec_type));
    if (types.has("video")) return { kind: "video", duration: Number(j.format?.duration) || 0 };
    if (types.has("audio")) return { kind: "audio" };
    return { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

// H.264 at half size (at most 1080 tall), AAC, the original's timecode and
// metadata kept (§25.2: the proxy then has the original's frames and start TC).
export async function makeProxy(src: string, dest: string, duration: number, progress: (p: number) => void, ffmpeg = findFfmpeg()): Promise<void> {
  if (!ffmpeg) throw new Error("ffmpeg isn't on this PC");
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.making.mp4`;
  const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a?",
    "-vf", "scale=-2:'min(1080,trunc(ih/4)*2)'", ...(await h264Args(ffmpeg, src)),
    "-c:a", "aac", "-b:a", "160k", "-map_metadata", "0", "-movflags", "+faststart", "-progress", "pipe:1", tmp];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-500); });
    child.stdout.on("data", (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && duration > 0) progress(Math.min(1, Number(m[1]) / 1e6 / duration));
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim() || `exit ${code}`}`))));
  }).catch(async (e) => {
    await rm(tmp, { force: true });
    throw e;
  });
  await rename(tmp, dest);
}

// Proxies this PC made, kept by the original's fingerprint hash.
export class ProxyCache {
  private readonly dir: string;
  private readonly making = new Map<string, Promise<string>>();
  private readonly progress = new Map<string, ((p: number) => void)[]>();

  constructor(dir: string) {
    this.dir = dir;
  }

  // The proxy for `src` (fingerprint hash `hash`), made if it isn't here yet;
  // asking while it's being made joins that.
  async get(hash: string, src: string, duration: number, onProgress: (p: number) => void): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("bad fingerprint");
    const path = join(this.dir, `${hash}.mp4`);
    if (existsSync(path) && (await stat(path)).size > 0) return path;
    this.progress.set(hash, [...(this.progress.get(hash) ?? []), onProgress]);
    let job = this.making.get(hash);
    if (!job) {
      job = makeProxy(src, path, duration, (p) => { for (const f of this.progress.get(hash) ?? []) f(p); })
        .then(() => path)
        .finally(() => { this.making.delete(hash); this.progress.delete(hash); });
      this.making.set(hash, job);
    }
    return job;
  }
}
