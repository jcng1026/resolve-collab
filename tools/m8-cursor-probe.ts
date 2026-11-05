// Probe for ghost cursors (SPEC §24.6), no second PC needed. Opens the
// companion window and, over Resolve's window, two test cursors:
// - "Under" sits exactly on your pointer: its tip should be under yours.
// - "Mirror" is your pointer mirrored left-right: crossing the middle brings
//   your pointer onto it, and its name should show.
// Ctrl+C to stop.
//   node tools/m8-cursor-probe.ts

import { tmpdir } from "node:os";
import { join } from "node:path";
import { MouseWatch } from "../src/bridge/mouse-watch.ts";
import { CompanionWindow } from "../src/window/window-host.ts";

const win = new CompanionWindow(join(tmpdir(), "rc-cursor-probe.json"));
if (!win.start()) throw new Error("Electron didn't start");
win.on("closed", () => process.exit(0));
win.on("action", (a: { type: string }) => { if (a.type === "close") process.exit(0); });
win.show({ view: "start", name: "Probe", start: { bridge: false, project: "", canResume: false, joining: false, message: "Cursor probe: look at Resolve." } });

const mouse = new MouseWatch(console.log);
let last = "";
mouse.onChange = (st) => {
  const r = st.resolve;
  const line = `front=${st.front} pointer=${st.pointer.join(",")} resolve=${r ? r.join(",") : "none"}`;
  if (line !== last) console.log((last = line));
  if (!r) return win.overlay(null);
  const x = Math.min(1, Math.max(0, (st.pointer[0] - r[0]) / r[2]));
  const y = Math.min(1, Math.max(0, (st.pointer[1] - r[1]) / r[3]));
  const mx = 1 - x;
  const near = Math.hypot(st.pointer[0] - (r[0] + mx * r[2]), 0) <= 24;
  win.overlay({ rect: r, cursors: [
    { id: "u", name: "Under", color: "#64D2FF", x, y, near: false },
    { id: "m", name: "Mirror", color: "#FFD60A", x: mx, y, near },
  ] });
};
mouse.start();
process.on("SIGINT", () => { mouse.stop(); win.stop(); setTimeout(() => process.exit(0), 300); });
