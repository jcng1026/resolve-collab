// The installed app puts its bridge into Resolve at every start (SPEC §26.1):
// added, updated, or left alone when it's already the same.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("adds the bridge, leaves it when it's the same, and replaces a different one", async () => {
  const appdata = mkdtempSync(join(tmpdir(), "rc-appdata-"));
  process.env.APPDATA = appdata; // where Resolve's Scripts folder is, read when install.ts loads
  const { installBridge } = await import("./install.ts");
  const inbox = join(homedir(), "ResolveCollab", "inbox"); // the real one: short enough, only made if missing
  const first = installBridge(inbox);
  expect(first.state).toBe("new");
  expect(first.path.startsWith(appdata)).toBe(true);
  const text = readFileSync(first.path, "utf8");
  expect(text).toContain(inbox);
  expect(text).toContain(first.build);
  expect(installBridge(inbox).state).toBe("same");
  writeFileSync(first.path, "-- an older bridge");
  expect(installBridge(inbox).state).toBe("updated");
  expect(readFileSync(first.path, "utf8")).toBe(text);
  expect(() => installBridge(join(tmpdir(), "a".repeat(60)))).toThrow(/too long/);
});
