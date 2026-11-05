// Probe for ghost cursors (SPEC §24.6, §24.6.1), no second PC needed. Opens
// the companion window and, over Resolve's window, two test cursors:
// - "Under" goes the whole way: your pointer → panel, frame and track (read
//   off your screen) → back onto your screen. Its tip should be under yours.
// - "Pinned" is frozen where your pointer was 4 s after starting. On the
//   timeline it's kept at that frame and track: zoom or scroll the timeline
//   and it should move with the clip, as another PC's arrow would.
// The terminal shows what's read. Ctrl+C to stop.
//   node tools/m8-cursor-probe.ts [fps]

import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutWatch } from "../src/bridge/layout-watch.ts";
import { MouseWatch } from "../src/bridge/mouse-watch.ts";
import { type Placed, type Spot, locate, place, prepare } from "../src/layout.ts";
import { CompanionWindow } from "../src/window/window-host.ts";

const fps = Number(process.argv[2] ?? 24);
const win = new CompanionWindow(join(tmpdir(), "rc-cursor-probe.json"));
if (!win.start()) throw new Error("Electron didn't start");
win.on("closed", () => process.exit(0));
win.on("action", (a: { type: string }) => { if (a.type === "close") process.exit(0); });
win.show({ view: "start", name: "Probe", start: { bridge: false, project: "", canResume: false, joining: false, message: "Cursor probe: look at Resolve." } });

const mouse = new MouseWatch(console.log);
const layout = new LayoutWatch(console.log);
let placed: Placed | undefined;
let pinned: Spot | undefined;
setTimeout(() => {
  const st = mouse.latest;
  if (st && placed) pinned = locate(placed, st.pointer[0], st.pointer[1]);
  console.log(`pinned: ${JSON.stringify(pinned)}`);
}, 4000);

function relayout(): void {
  const l = layout.latest;
  const r = mouse.latest?.resolve;
  // Tracks named Resolve's default way ("Video 1", "Audio 2").
  const tracks = (l?.heads ?? []).flatMap((h) => {
    const m = /^(Video|Audio) (\d+)$/.exec(h.text);
    return m ? [{ kind: m[1] === "Video" ? "video" as const : "audio" as const, order: Number(m[2]), name: h.text }] : [];
  });
  placed = l && r ? prepare({ ...l, window: r }, fps, tracks) : undefined;
}
layout.onChange = (l) => {
  relayout();
  console.log(`panels ${Object.keys(l.panels).join(",")} · ruler ${placed?.ruler ? `${placed.ruler.perFrame.toFixed(3)} px/frame` : "not read"} · tracks ${[...(placed?.rows.keys() ?? [])].join(",") || "none"}`);
  draw();
};

let lastRect = "";
function draw(): void {
  const st = mouse.latest;
  const r = st?.resolve;
  if (!st || !r || !placed) return win.overlay(null);
  const toWin = (at: { x: number; y: number }) => ({ x: (at.x - r[0]) / r[2], y: (at.y - r[1]) / r[3] });
  const cursors = [];
  const spot = locate(placed, st.pointer[0], st.pointer[1]);
  const under = spot && place(placed, spot, fps, true);
  if (under) cursors.push({ id: "u", name: "Under", color: "#64D2FF", ...toWin(under), near: false });
  const pin = pinned && place(placed, pinned, fps, true);
  if (pin) cursors.push({ id: "p", name: "Pinned", color: "#FFD60A", ...toWin(pin), near: true, ...(pin.edge ? { edge: pin.edge, hint: pin.hint } : {}) });
  win.overlay(cursors.length ? { rect: r, cursors } : null);
}
mouse.onChange = (st) => {
  if (String(st.resolve) !== lastRect) { lastRect = String(st.resolve); relayout(); }
  draw();
};
mouse.start();
layout.start();
process.on("SIGINT", () => { mouse.stop(); layout.stop(); win.stop(); setTimeout(() => process.exit(0), 300); });
