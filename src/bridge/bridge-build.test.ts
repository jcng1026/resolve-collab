import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge-client.ts";
import { bridgeBuild, buildWarning } from "./bridge-build.ts";
import { FakeBridge } from "./fake-bridge.ts";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rc-build-"));
  const logPath = join(dir, "ResolveDebug.txt");
  const inboxDir = join(dir, "inbox");
  writeFileSync(logPath, "");
  const client = new BridgeClient({ logPath, inboxDir, pollMs: 10 });
  client.start();
  const fake = new FakeBridge(logPath, inboxDir);
  stops.push(() => client.stop(), () => fake.stop());
  return { client, fake, logPath, inboxDir };
}

const until = <T>(emitter: BridgeClient, event: string) => new Promise<T>((resolve) => emitter.once(event, (value: T) => resolve(value)));

describe("the bridge's build", () => {
  it("is a short hash of the bridge source", () => {
    expect(bridgeBuild("local x = 1")).toMatch(/^[0-9a-f]{12}$/);
    expect(bridgeBuild("local x = 1")).toBe(bridgeBuild("local x = 1"));
    expect(bridgeBuild("local x = 2")).not.toBe(bridgeBuild("local x = 1"));
  });

  it("warns only when the running bridge isn't this companion's", () => {
    expect(buildWarning("abc123abc123", "abc123abc123")).toBeNull();
    expect(buildWarning("abc123abc123", "000000000000")).toMatch(/install-bridge/);
    // Installed before builds were stamped.
    expect(buildWarning("abc123abc123", undefined)).toMatch(/install-bridge/);
    expect(buildWarning("abc123abc123", "__BUILD__")).toMatch(/install-bridge/);
  });

  it("is reported from HELLO", async () => {
    const { client, fake } = setup();
    fake.build = "aaaaaaaaaaaa";
    const build = until<string | undefined>(client, "build");
    fake.start(10);
    expect(await build).toBe("aaaaaaaaaaaa");
  });

  it("is reported from a heartbeat when the bridge was already running", async () => {
    const { fake, logPath, inboxDir } = setup();
    fake.build = "bbbbbbbbbbbb";
    fake.start(10);
    await new Promise((r) => setTimeout(r, 50));
    // A companion started after the bridge sees no HELLO.
    const late = new BridgeClient({ logPath, inboxDir, pollMs: 10 });
    stops.push(() => late.stop());
    const build = until<string | undefined>(late, "build");
    late.start();
    expect(await build).toBe("bbbbbbbbbbbb");
  });
});
