import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge-client.ts";
import { FakeBridge, type FakeClip } from "./fake-bridge.ts";

const clip: FakeClip = {
  timeline: "Timeline 1",
  track: 1,
  start: 86400,
  end: 86448,
  srcStart: 0,
  srcEnd: 48,
  media: { name: "interview.mp4", path: "C:\\media\\interview.mp4", frames: 240 },
};

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rc-bridge-"));
  const logPath = join(dir, "ResolveDebug.txt");
  const inboxDir = join(dir, "inbox");
  writeFileSync(logPath, "old line from before the companion started\n");
  const client = new BridgeClient({ logPath, inboxDir, pollMs: 10, commandTimeoutMs: 1000 });
  client.start();
  const fake = new FakeBridge(logPath, inboxDir);
  stops.push(() => client.stop(), () => fake.stop());
  return { client, fake, inboxDir };
}

const until = <T>(emitter: BridgeClient, event: string) =>
  new Promise<T>((resolve) => emitter.once(event, (value: T) => resolve(value)));

describe("BridgeClient with a fake bridge", () => {
  it("connects on HELLO and reports liveness", async () => {
    const { client, fake } = setup();
    const hello = until(client, "hello");
    const alive = until<boolean>(client, "alive");
    fake.start(10);
    expect(await hello).toMatchObject({ product: "Fake Resolve" });
    expect(await alive).toBe(true);
    expect(client.connected).toBe(true);
  });

  it("sends a command through the inbox, gets the result, and clears acknowledged folders", async () => {
    const { client, fake, inboxDir } = setup();
    fake.media.add("interview.mp4");
    fake.start(10);
    await until(client, "hello");
    const result = await client.send({ type: "clip.append", ...clip } as never);
    expect(result).toMatchObject({ ok: true });
    expect(fake.clips).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(inboxDir)).toEqual([]);
  });

  it("reports media-missing from the bridge", async () => {
    const { client, fake } = setup();
    fake.start(10);
    await until(client, "hello");
    expect(await client.send({ type: "clip.append", ...clip } as never)).toMatchObject({ ok: false, error: "media-missing" });
  });

  it("forwards local change events", async () => {
    const { client, fake } = setup();
    fake.start(10);
    await until(client, "hello");
    const event = until<Record<string, unknown>>(client, "event");
    fake.addLocalClip(clip);
    expect(await event).toMatchObject({ type: "clip.added", start: 86400 });
  });

  it("times out when no bridge answers", async () => {
    const { client } = setup();
    expect(await client.send({ type: "clip.append" })).toEqual({ ok: false, error: "timeout" });
  });
});
