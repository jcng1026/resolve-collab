import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadIdentity, saveName } from "./identity.ts";
import { PeerLink, newInviteCode } from "./peer-link.ts";

describe("this PC's identity (SPEC §22.1)", () => {
  it("is made once and kept, with the name added later", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-id-"));
    const first = loadIdentity(dir);
    expect(first.seed).toHaveLength(32);
    expect(first.name).toBeUndefined();
    saveName(dir, "Jo");
    const again = loadIdentity(dir);
    expect(again.seed.equals(first.seed)).toBe(true);
    expect(again.name).toBe("Jo");
    expect(JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")).seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the peer link the same key every time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-id-"));
    const { seed } = loadIdentity(dir);
    const a = new PeerLink(newInviteCode(), { seed });
    const b = new PeerLink(newInviteCode(), { seed });
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.id).toBe(a.publicKey.slice(0, 8));
    await Promise.all([a.stop(), b.stop()]);
  });
});
