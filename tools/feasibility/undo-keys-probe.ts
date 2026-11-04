// Probe for SPEC §23.4: can the companion claim Ctrl+Z / Ctrl+Shift+Z while
// Resolve is in front (so Resolve doesn't undo), and give them back?
//   node tools/feasibility/undo-keys-probe.ts [seconds]
// Prints every event with a time. "on" is sent at start; after half the time
// "off" is sent, so Resolve's own Ctrl+Z should work again.

import { UndoKeys } from "../../src/bridge/undo-keys.ts";

const seconds = Number(process.argv[2] ?? 120);
const say = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)}  ${m}`);
const keys = new UndoKeys();
for (const e of ["undo", "redo", "armed", "released", "taken", "gone"]) keys.on(e, (why?: string) => say(why ? `${e}: ${why}` : e));
keys.start();
keys.allow(true);
say(`allowed for ${seconds / 2} s: bring Resolve to the front and press Ctrl+Z / Ctrl+Shift+Z`);
setTimeout(() => { keys.allow(false); say("not allowed now: Resolve's own Ctrl+Z should work again"); }, (seconds / 2) * 1000);
setTimeout(() => { keys.stop(); say("done"); process.exit(0); }, seconds * 1000);
