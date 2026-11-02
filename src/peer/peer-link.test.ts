import { afterAll, describe, expect, it } from "vitest";
import { PeerLink, newInviteCode, topicFor } from "./peer-link.ts";

describe("topicFor", () => {
  it("derives a stable 32-byte topic and rejects malformed codes", () => {
    const code = newInviteCode();
    expect(topicFor(code)).toEqual(topicFor(code));
    expect(topicFor(code)).toHaveLength(32);
    expect(topicFor(newInviteCode())).not.toEqual(topicFor(code));
    expect(() => topicFor("not-a-code")).toThrow();
  });
});

// Uses the public Hyperswarm DHT, so it needs internet access.
describe.skipIf(process.env.RC_SKIP_NETWORK === "1")("PeerLink over Hyperswarm", () => {
  const code = newInviteCode();
  const a = new PeerLink(code);
  const b = new PeerLink(code);
  afterAll(async () => {
    await Promise.all([a.stop(), b.stop()]);
  });

  it("connects two peers on the same invite code and exchanges messages", async () => {
    const connected = Promise.all([
      new Promise((resolve) => a.once("peer", resolve)),
      new Promise((resolve) => b.once("peer", resolve)),
    ]);
    await Promise.all([a.start(), b.start()]);
    await connected;
    const received = new Promise((resolve) => b.once("message", (message) => resolve(message)));
    a.send({ type: "op", n: 1 });
    expect(await received).toEqual({ type: "op", n: 1 });
  }, 60_000);
});
