// Sending media between PCs (SPEC §25.3): chunks, checks, resume, sources.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanName, inside, mediaPath } from "./paths.ts";
import { CHUNK, type JsonObject, type Kind, MediaTransfer, type Prepared, sha256File } from "./transfer.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rc-transfer-")); dirs.push(d); return d; };
const all: MediaTransfer[] = [];
afterEach(() => { for (const t of all.splice(0)) t.stop(); });

// PCs wired together in memory. `drop` loses loose messages (chunks) at random.
function network(drop = 0, corrupt = false) {
  const nodes = new Map<string, MediaTransfer>();
  const deliver = (to: string, from: string, m: JsonObject, loose: boolean) => {
    if (!nodes.has(to)) return false;
    if (loose && Math.random() < drop) return true;
    let copy = JSON.parse(JSON.stringify(m)) as JsonObject;
    if (corrupt && copy.type === "media-chunk" && copy.i === 0 && !(deliver as { done?: boolean }).done) {
      (deliver as { done?: boolean }).done = true;
      copy = { ...copy, d: Buffer.from("tampered").toString("base64") };
    }
    setImmediate(() => void nodes.get(to)?.message(from, copy));
    return true;
  };
  const add = (id: string, files: Record<string, string> = {}, allowed = () => true, onChange?: () => void) => {
    const t = new MediaTransfer({
      send: (to, m) => deliver(to, id, m, false),
      sendLoose: (to, m) => deliver(to, id, m, true),
      allowed,
      prepare: async (clip: string, _kind: Kind, progress): Promise<Prepared | { error: string }> => {
        const path = files[clip];
        if (!path) return { error: "not here" };
        progress(0.5);
        return { path, size: readFileSync(path).length, sha256: await sha256File(path) };
      },
      log: () => {},
      chunkTimeoutMs: 200,
      ...(onChange ? { onChange } : {}),
    });
    nodes.set(id, t);
    all.push(t);
    return t;
  };
  return { add, remove: (id: string) => { nodes.get(id)?.stop(); nodes.delete(id); } };
}

function file(size: number): string {
  const p = join(tmp(), "source.mov");
  writeFileSync(p, randomBytes(size));
  return p;
}

describe("sending media between PCs (SPEC §25.3)", () => {
  it("sends a file in checked chunks, even when some get lost on the way", async () => {
    const src = file(5 * CHUNK + 1234);
    const net = network(0.2);
    net.add("jo", { clip1: src });
    const me = net.add("sam");
    const dest = join(tmp(), "Interviews", "Interview_03.mov");
    const got = await me.want("clip1", "original", dest, () => ["jo"]);
    expect(got).toBe(dest);
    expect(readFileSync(dest).equals(readFileSync(src))).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  }, 60_000);

  it("refuses a damaged chunk and asks for it again", async () => {
    const src = file(3 * CHUNK);
    const net = network(0, true);
    net.add("jo", { clip1: src });
    const me = net.add("sam");
    const dest = join(tmp(), "a.mov");
    expect(await me.want("clip1", "proxy", dest, () => ["jo"])).toBe(dest);
    expect(readFileSync(dest).equals(readFileSync(src))).toBe(true);
  });

  it("carries on from the chunks already here, from another source", async () => {
    const src = file(64 * CHUNK);
    const dest = join(tmp(), "b.mov");
    const net = network();
    net.add("jo", { clip1: src });
    net.add("kim", { clip1: src });
    // Paused once the first chunks are in, then Jo goes and Kim sends the rest.
    let once = false;
    let paused: () => void = () => {};
    const halfway = new Promise<void>((r) => { paused = r; });
    const me: MediaTransfer = net.add("sam", {}, () => true, () => {
      const d = me?.list()[0];
      if (!once && d?.state === "downloading" && d.received >= 3 * CHUNK) { once = true; me.pause("clip1", "original"); paused(); }
    });
    let sources = ["jo"];
    const done = me.want("clip1", "original", dest, () => sources);
    await halfway;
    await new Promise((r) => setTimeout(r, 50));
    const part = JSON.parse(readFileSync(`${dest}.part.json`, "utf8")) as { have: number[] };
    expect(part.have.length).toBeGreaterThan(0);
    net.remove("jo");
    me.peerLeft("jo");
    sources = ["kim"];
    me.resume("clip1", "original");
    expect(await done).toBe(dest);
    expect(readFileSync(dest).equals(readFileSync(src))).toBe(true);
  });

  it("gets nothing a source won't give: not allowed, or not there; then tries the next source", async () => {
    const src = file(CHUNK);
    const net = network();
    net.add("jo", { clip1: src }, () => false);
    net.add("kim", { clip1: src });
    const me = net.add("sam");
    const dest = join(tmp(), "c.mov");
    expect(await me.want("clip1", "original", dest, () => ["jo", "kim"])).toBe(dest);
    expect(await me.want("clip9", "original", join(tmp(), "d.mov"), () => ["kim"])).toBeUndefined();
  });

  it("keeps every name inside the media folder", () => {
    const root = tmp();
    expect(cleanName("..")).toBe("media");
    expect(cleanName("CON.mp4")).toBe("_CON.mp4");
    expect(cleanName(String.raw`a<b>:c"/d\e|f?g*.mov `)).toBe("a_b__c__d_e_f_g_.mov");
    expect(mediaPath(root, ["Day 1", ".."], String.raw`..\..\evil.exe`, "original")).toBe(join(root, "Day 1", "Bin", ".._.._evil.exe"));
    expect(mediaPath(root, ["Interviews"], "Interview_03.mov", "proxy")).toBe(join(root, "Interviews", "Interview_03 (proxy).mp4"));
    expect(inside(root, join(root, "..", "x"))).toBe(false);
    expect(inside(root, String.raw`C:\Windows\x`)).toBe(false);
  });
});
