// Generates test files for the two candidate inbound channels on Resolve Free
// (docs/feasibility/findings-2026-11-02.md, "Blocking problem"):
//   1. keyboard presets whose *file name* carries the message
//   2. an OTIO timeline whose marker notes carry the message
// Run with: node tools/feasibility/inbound.ts

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./lib.ts";

const OUT = join(STATE_DIR, "inbound");
const TEMPLATE = join(STATE_DIR, "out", "kb_template"); // exported by Resolve from the Console

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Payload of exactly `length` hex characters, so truncation is easy to spot.
function payload(length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += (i % 256).toString(16).padStart(2, "0");
  return out.slice(0, length);
}

// Preset names come from the file base name; Windows allows 255 characters.
for (const length of [40, 120, 200, 240]) {
  copyFileSync(TEMPLATE, join(OUT, `RCMSG_${length}_${payload(length)}`));
}
writeFileSync(join(OUT, `RCMSG_min_${payload(40)}`), "# ResolveCollab inbound test\r\n");

const rt = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: 24.0, value });
const marker = (name: string, note: string, frame: number) => ({
  OTIO_SCHEMA: "Marker.2",
  metadata: { Resolve_OTIO: { Keywords: [], Note: note } },
  name,
  color: "BLUE",
  marked_range: { OTIO_SCHEMA: "TimeRange.1", duration: rt(1), start_time: rt(86400 + frame) },
});

const timeline = {
  OTIO_SCHEMA: "Timeline.1",
  metadata: { Resolve_OTIO: { "Resolve OTIO Meta Version": "1.0" } },
  name: "RCMSG inbound",
  global_start_time: rt(86400),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    metadata: {},
    name: "",
    source_range: null,
    effects: [],
    markers: [marker("m100", payload(100), 1), marker("m1000", payload(1000), 2), marker("m10000", payload(10000), 3)],
    enabled: true,
    children: [
      {
        OTIO_SCHEMA: "Track.1",
        metadata: {},
        name: "Video 1",
        source_range: null,
        effects: [],
        markers: [],
        enabled: true,
        kind: "Video",
        children: [{ OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: { OTIO_SCHEMA: "TimeRange.1", duration: rt(24), start_time: rt(0) }, effects: [], markers: [], enabled: true }],
      },
    ],
  },
};
writeFileSync(join(OUT, "message.otio"), JSON.stringify(timeline, null, 2));

console.log(`Wrote inbound test files to ${OUT}`);
