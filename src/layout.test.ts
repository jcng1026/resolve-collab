// Ghost cursors placed by panel, frame and track (SPEC §24.6.1), with the
// ruler and track names as the probe read them on Resolve 21.1.2.

import { describe, expect, it } from "vitest";
import { type ScreenLayout, type Text, cleanSpot, locate, place, prepare } from "./layout.ts";

const word = (text: string, x: number, y = 616): Text => ({ text, x, y, w: 27, h: 9 });
const tracks = [{ kind: "video" as const, order: 1, name: "Video 1" }, { kind: "audio" as const, order: 1, name: "Audio 1" }];
const heads = [{ text: "Video 1", x: 474, y: 757, w: 38, h: 10 }, { text: "Audio 1", x: 474, y: 872, w: 38, h: 10 }];

function screen(ruler: Text[], over: Partial<ScreenLayout> = {}): ScreenLayout {
  return {
    window: [0, 0, 1920, 1080],
    panels: { mediapool: [0, 66, 455, 483], viewer: [456, 66, 1043, 484], inspector: [1500, 66, 420, 484], timeline: [456, 602, 1464, 430] },
    ruler, heads, scale: 1, ...over,
  };
}
// 8 s = 192 px, and zoomed in twice: 4 s = 384 px (the probe's readings).
const normal = prepare(screen([word("01:00", 722), word("0000", 752), word("01:00", 914), word("0800", 944)]), 24, tracks);
const zoomed = prepare(screen([word("01:00", 722), word("0000", 752), word("01:00", 1106), word("0400", 1136), word("01:00", 1490), word("0800", 1520)]), 24, tracks);
const START = 3600 * 24; // 01:00:00:00 in frames

describe("ghost cursors by panel, frame and track (SPEC §24.6.1)", () => {
  it("reads the ruler: where each frame is", () => {
    expect(normal.ruler).toEqual({ x0: 716, frame0: START, perFrame: 1 });
    expect(zoomed.ruler).toEqual({ x0: 716, frame0: START, perFrame: 4 });
  });

  it("puts a pointer on the timeline at the same frame and track on a PC zoomed differently", () => {
    const spot = locate(normal, 958, 760)!; // on the clip, by its name in Video 1
    expect(spot).toMatchObject({ panel: "timeline", frame: START + 242, track: "V1" });
    expect(place(zoomed, spot, 24, true)).toEqual({ x: 716 + 242 * 4, y: 760 });
    // Audio 1, 20 px below its name.
    expect(locate(normal, 958, 892)).toMatchObject({ track: "A1", dy: 2 });
  });

  it("waits at the timeline's edge, with the timecode, when that frame is out of view", () => {
    const spot = locate(normal, 1116, 760)!; // 400 frames in: past the zoomed PC's right edge
    expect(place(zoomed, spot, 24, true)).toEqual({ x: 1919, y: 760, edge: "right", hint: "→ 01:00:16:16" });
  });

  it("uses the same spot of the same panel, wherever that panel is, and hides when it isn't shown", () => {
    const spot = locate(normal, 455 / 2, 66 + 483 / 2)!;
    expect(spot).toEqual({ panel: "mediapool", u: 0.5, v: 0.5 });
    const moved = prepare(screen([], { panels: { mediapool: [1500, 600, 400, 400] } }), 24, tracks);
    expect(place(moved, spot, 24, true)).toEqual({ x: 1700, y: 800 });
    const none = prepare(screen([], { panels: {} }), 24, tracks);
    expect(place(none, spot, 24, true)).toBeUndefined();
  });

  it("falls back to the panel's spot when the ruler can't be trusted, or on another timeline", () => {
    const uneven = prepare(screen([word("01:00", 722), word("0000", 752), word("01:00", 914), word("0800", 944), word("01:00", 1200), word("1600", 1230)]), 24, tracks);
    expect(uneven.ruler).toBeUndefined();
    const one = prepare(screen([word("01:00", 722), word("0000", 752)]), 24, tracks);
    expect(one.ruler).toBeUndefined();
    const spot = locate(normal, 958, 760)!;
    const byPanel = { x: 456 + spot.u * 1464, y: 602 + spot.v * 430 };
    expect(place(zoomed, spot, 24, false)).toEqual(byPanel);
    // The big timecode left of the ruler isn't a ruler label.
    const withDisplay = prepare(screen([word("01:00", 530), word("0000", 560), ...normal.layout.ruler]), 24, tracks);
    expect(withDisplay.ruler).toEqual(normal.ruler);
  });

  it("checks spots from other PCs", () => {
    expect(cleanSpot({ panel: "timeline", u: 0.5, v: 0.2, frame: 90000, track: "V2", dy: 1.5 })).toEqual({ panel: "timeline", u: 0.5, v: 0.2, frame: 90000, track: "V2", dy: 1.5 });
    expect(cleanSpot({ panel: "timeline", u: 0.5, v: 0.2, frame: 1.5, track: "<b>", dy: 1 })).toEqual({ panel: "timeline", u: 0.5, v: 0.2 });
    expect(cleanSpot({ panel: "desktop", u: 0.5, v: 0.5 })).toBeUndefined();
    expect(cleanSpot({ panel: "viewer", u: 2, v: 0.5 })).toBeUndefined();
  });
});
