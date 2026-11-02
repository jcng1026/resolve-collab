import createTestnet from "hyperdht/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PeerLink, type PeerLinkOptions, newInviteCode, topicFor } from "./peer-link.ts";

describe("topicFor", () => {
  it("derives a stable 32-byte topic and rejects malformed codes", () => {
    const code = newInviteCode();
    expect(topicFor(code)).toEqual(topicFor(code));
    expect(topicFor(code)).toHaveLength(32);
    expect(topicFor(newInviteCode())).not.toEqual(topicFor(code));
    expect(() => topicFor("not-a-code")).toThrow();
  });
});

async function exchange(options: PeerLinkOptions) {
  const code = newInviteCode();
  const a = new PeerLink(code, options);
  const b = new PeerLink(code, options);
  try {
    const connected = Promise.all([
      new Promise((resolve) => a.once("peer", resolve)),
      new Promise((resolve) => b.once("peer", resolve)),
    ]);
    await Promise.all([a.start(), b.start()]);
    await connected;
    // Sent straight away, while Hyperswarm is still swapping duplicate
    // connections: each must arrive exactly once.
    const received: unknown[] = [];
    b.on("message", (message) => received.push(message));
    for (let n = 1; n <= 5; n++) a.send({ type: "op", n });
    while (received.length < 5) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1500)); // time for any duplicate resends
    expect(received).toHaveLength(5);
    expect(new Set(received.map((m) => (m as { n: number }).n))).toEqual(new Set([1, 2, 3, 4, 5]));
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
}

describe("PeerLink on a local DHT testnet", () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await testnet.destroy();
  });

  it("connects two peers on the same invite code and exchanges messages", async () => {
    await exchange({ bootstrap: testnet.bootstrap });
  }, 20_000);
});

// Public discovery takes ~10–60 s, so this only runs when asked: RC_NETWORK=1.
describe.runIf(process.env.RC_NETWORK === "1")("PeerLink on the public Hyperswarm network", () => {
  it("connects and exchanges messages", async () => {
    await exchange({});
  }, 120_000);
});
