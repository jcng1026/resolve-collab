// Proxies made the companion's way keep the original's frames and timecode
// (SPEC §25.2); audio and stills aren't proxied. Needs ffmpeg (skipped without).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProxyCache, classify, findFfmpeg } from "./proxy.ts";

const ffmpeg = findFfmpeg();
const probe = (path: string) => JSON.parse(execFileSync(join(dirname(ffmpeg!), "ffprobe.exe"), ["-v", "error", "-show_entries", "stream=codec_type,width,height,nb_frames:stream_tags=timecode", "-of", "json", path], { encoding: "utf8" })) as { streams: { codec_type: string; width?: number; height?: number; nb_frames?: string; tags?: { timecode?: string } }[] };

describe.skipIf(!ffmpeg)("proxies (SPEC §25.2, §25.3)", () => {
  it("makes a half-size H.264 proxy with the same frames and start timecode, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-proxy-"));
    const src = join(dir, "camera.mov");
    execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-timecode", "10:00:00:00", src]);
    expect(await classify(src)).toEqual({ kind: "video", duration: expect.closeTo(2, 1) });
    const cache = new ProxyCache(join(dir, "proxies"));
    const seen: number[] = [];
    const hash = "a".repeat(64);
    const [a, b] = await Promise.all([cache.get(hash, src, 2, (p) => seen.push(p)), cache.get(hash, src, 2, () => {})]);
    expect(a).toBe(b);
    const video = probe(a).streams.find((s) => s.codec_type === "video")!;
    expect([video.width, video.height, video.nb_frames, video.tags?.timecode]).toEqual([960, 540, "48", "10:00:00:00"]);
    expect(probe(a).streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  }, 60_000);

  it("sends audio and stills as they are, and can't proxy what it can't read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-proxy-"));
    const wav = join(dir, "music.wav");
    execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1", wav]);
    expect(await classify(wav)).toEqual({ kind: "audio" });
    expect(await classify(join(dir, "logo.PNG"))).toEqual({ kind: "still" });
    const junk = join(dir, "A001.braw");
    writeFileSync(junk, Buffer.alloc(4096, 7));
    expect(await classify(junk)).toEqual({ kind: "unreadable" });
  });
});
