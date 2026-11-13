// Shows the companion window with made-up media state (SPEC §25.1), to look
// at the media cards and the Media panel without two PCs. Ctrl+C to stop.
//   node tools/m9-window-preview.ts

import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThumbCache } from "../src/media/thumbs.ts";
import { CompanionWindow } from "../src/window/window-host.ts";

const GB = 1024 ** 3;
// Real first-frame thumbnails from the test media (node tools/feasibility/prepare.ts), under made-up fingerprints.
const MEDIA = join(import.meta.dirname, "..", "local", "feasibility", "media");
const thumbsDir = join(tmpdir(), "rc-preview-thumbs");
const cache = new ThumbCache(thumbsDir);
const thumbOf = async (n: number, file: string) => (await cache.make(String(n).repeat(64).slice(0, 64), join(MEDIA, file)))?.hash;
const t = [await thumbOf(1, "camera.mp4"), await thumbOf(2, "original.mp4"), await thumbOf(3, "spare.mp4"), await thumbOf(4, "alt.mp4"), await thumbOf(5, "fps30.mp4")];
const item = (id: string, name: string, bin: string, state: string, extra: object = {}) =>
  ({ id, name, bin, state, kind: "proxy", progress: 0, got: 0, total: 0, making: false, from: "", size: 2 * GB, note: "", ...extra });

const state = {
  view: "session", name: "Sam", project: "Test1", role: "member", live: true, code: "", following: null, myTimecode: "01:00:00:00",
  people: [{ id: "a", name: "Jo", color: "#FF9F0A", online: true, idle: false, you: false, page: "Edit page" }, { id: "b", name: "Sam", color: "#409CFF", online: true, idle: false, you: true, page: "Edit page" }],
  lines: [{ id: 1, kind: "chat", at: Date.now(), author: "a", name: "Jo", text: "Added the day 2 interviews.", changes: [] }],
  urgent: [{ id: "m-big", who: "", text: "Download proxies for 12 clips? They take about 7.4 GB. You have 118.0 GB free.", actions: [{ label: "Download", value: "yes" }, { label: "Not now", value: "no" }] }],
  members: [], missing: [], review: null, start: {},
  media: {
    folder: "C:\\Users\\Sam\\Videos\\ResolveCollab\\Test1", used: 2.3 * GB, free: 118 * GB, originalsBytes: 12.4 * GB,
    progress: { title: "4 clips missing", detail: "Downloading proxies from Jo · 1.2 GB of 3.4 GB", pct: 0.35, paused: false },
    sending: [{ name: "Kim", clip: "Interview_03.mov", making: false }],
    items: [
      item("1", "A001_C003.braw", "Day 1", "noproxy", { size: 4.2 * GB }),
      item("2", "Interview_03.mov", "Interviews", "downloading", { progress: 0.35, from: "Jo", thumb: t[0], duration: 754 }),
      item("3", "Interview_04.mov", "Interviews", "queued", { thumb: t[1], duration: 612 }),
      item("4", "Broll_beach.mp4", "B-roll", "proxy", { size: 2.1 * GB, thumb: t[2], duration: 18 }),
      item("8", "Broll_park.mp4", "B-roll", "proxy", { size: 1.4 * GB, thumb: t[4], duration: 9 }),
      item("5", "Broll_city.mp4", "B-roll", "paused", { kind: "original", progress: 0.6, from: "Alex", thumb: t[3], duration: 31 }),
      item("6", "Drone_01.mp4", "B-roll", "waiting", { note: "Only Kim has it, and they're offline" }),
      item("7", "Theme_v2.wav", "Music", "here", { kind: "original" }),
    ],
  },
};

const win = new CompanionWindow(join(tmpdir(), "rc-m9-preview.json"), thumbsDir);
if (!win.start()) throw new Error("Electron didn't start");
win.on("closed", () => process.exit(0));
win.on("action", (a: { type: string }) => console.log("action", JSON.stringify(a)));
win.show(state);
process.on("SIGINT", () => { win.stop(); setTimeout(() => process.exit(0), 300); });
