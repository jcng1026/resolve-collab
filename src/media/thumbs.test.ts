// Thumbnails for the Media grid: the first frame and length, made once; one
// from another PC kept only if it's a small JPEG.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFfmpeg } from "./proxy.ts";
import { THUMB_MAX, ThumbCache } from "./thumbs.ts";

const ffmpeg = findFfmpeg();
const hash = (c: string) => c.repeat(64);

describe.skipIf(!ffmpeg)("thumbnails", () => {
  it("makes the first frame of a video, 320 wide, with its length, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-thumbs-"));
    const src = join(dir, "shot.mov");
    execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=3", "-c:v", "mpeg4", "-q:v", "3", src]);
    const cache = new ThumbCache(join(dir, "thumbs"));
    const [a, b] = await Promise.all([cache.make(hash("a"), src), cache.make(hash("a"), src)]);
    expect(a).toEqual(b);
    expect(a!.duration).toBeCloseTo(3, 0);
    const jpg = readFileSync(join(dir, "thumbs", `${hash("a")}.jpg`));
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect(cache.get(hash("a"))).toEqual(a);
  });

  it("keeps another PC's thumbnail only if it's a small JPEG", async () => {
    const cache = new ThumbCache(join(mkdtempSync(join(tmpdir(), "rc-thumbs-")), "thumbs"));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    expect(await cache.put(hash("b"), jpeg, 12.5)).toEqual({ hash: hash("b"), duration: 12.5 });
    expect(await cache.put(hash("c"), Buffer.from("<svg onload=alert(1)>"), 1)).toBeUndefined();
    expect(await cache.put(hash("d"), Buffer.concat([jpeg, Buffer.alloc(THUMB_MAX)]), 1)).toBeUndefined();
    expect(await cache.put("../../evil", jpeg, 1)).toBeUndefined();
  });
});
