// One-PC check of M8's bridge parts in real Resolve (SPEC §8): presence
// reports, and presence.go moving the playhead and the page. Uses the project
// open now: it only moves the playhead and switches page, and puts both back.
//   node tools/install-bridge.ts, start Workspace > Scripts > ResolveCollab, then
//   node tools/m8-bridge-check.ts

import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeClient } from "../src/bridge/bridge-client.ts";

const RESOLVE_LOG = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Blackmagic Design", "DaVinci Resolve", "Support", "logs", "ResolveDebug.txt");
const say = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${m}`);
let failures = 0;
const bridge = new BridgeClient({ logPath: RESOLVE_LOG, inboxDir: join(homedir(), "ResolveCollab", "inbox") });
let presence: Record<string, unknown> | undefined;
bridge.on("event", (e: Record<string, unknown>) => {
  if (e.type === "presence") {
    presence = e;
    say(`presence: ${JSON.stringify(e)}`);
  }
});
bridge.on("attached", () => void bridge.send({ type: "mp.snapshot" }));
bridge.start();

async function waitFor(what: string, check: () => boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) { failures++; say(`FAIL  ${what}`); return false; }
    await new Promise((r) => setTimeout(r, 100));
  }
  say(`ok    ${what}`);
  return true;
}

await waitFor("bridge connected", () => bridge.connected, 60_000);
// The bridge reports presence once it changes; nudging the playhead makes one.
const nudge = await bridge.send({ type: "presence.go", timecode: "01:00:00:12" });
say(`presence.go timecode: ${JSON.stringify(nudge)}`);
await waitFor("a presence report with the page and timecode", () => typeof presence?.page === "string" && presence?.timecode === "01:00:00:12");
const before = { ...presence };
await bridge.send({ type: "presence.go", frame: 24 });
await waitFor("frame 24 from the start is 01:00:01:00 (on a 24 fps timeline starting at 01:00:00:00)", () => presence?.timecode === "01:00:01:00", 10_000);
await bridge.send({ type: "presence.go", page: "color" });
await waitFor("page color", () => presence?.page === "color");
await bridge.send({ type: "presence.go", page: String(before.page || "edit") });
await waitFor("page back", () => presence?.page === (before.page || "edit"));
const bad = await bridge.send({ type: "presence.go", page: "explode" });
if (bad.ok !== false || bad.error !== "bad-page") { failures++; say(`FAIL  bad page not refused: ${JSON.stringify(bad)}`); } else say("ok    a bad page is refused");
const unknown = await bridge.send({ type: "presence.go", timeline: "0".repeat(32) });
if (unknown.error !== "unknown-timeline") { failures++; say(`FAIL  unknown timeline: ${JSON.stringify(unknown)}`); } else say("ok    an unknown timeline is refused");
say(failures ? `${failures} check(s) FAILED` : "all checks passed");
bridge.stop();
process.exit(failures ? 1 : 0);
