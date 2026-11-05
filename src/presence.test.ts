// Presence messages are checked before use (SPEC §8, §13: peers send data).

import { describe, expect, it } from "vitest";
import { PALETTE, cleanPeople, cleanPresence, colorAt, whereText } from "./presence.ts";

const ok = { page: "edit", timeline: "a".repeat(32), timelineName: "Edit", timecode: "01:00:00:00", clip: "a.mp4" };

describe("presence", () => {
  it("accepts a well-formed presence and refuses anything else", () => {
    expect(cleanPresence({ ...ok, extra: "dropped" })).toEqual(ok);
    expect(cleanPresence({ ...ok, page: 3 })).toBeUndefined();
    expect(cleanPresence({ ...ok, clip: "x".repeat(300) })).toBeUndefined();
    expect(cleanPresence(null)).toBeUndefined();
  });

  it("accepts a people list only with known colours and plain fields", () => {
    const p = { id: "abcd1234", name: "Jo", color: PALETTE[1], online: true };
    expect(cleanPeople([p])).toEqual([p]);
    expect(cleanPeople([{ ...p, color: "red; background: url(x)" }])).toBeUndefined();
    expect(cleanPeople([{ ...p, online: "yes" }])).toBeUndefined();
    expect(cleanPeople("nope")).toBeUndefined();
  });

  it("gives colours in join order, wrapping round", () => {
    expect(colorAt(0)).toBe(PALETTE[0]);
    expect(colorAt(PALETTE.length + 2)).toBe(PALETTE[2]);
  });

  it("words where someone is", () => {
    expect(whereText(ok)).toBe("Edit · Edit · 01:00:00:00 · a.mp4");
    expect(whereText({ ...ok, timelineName: "", timecode: "", clip: "" })).toBe("Edit");
    expect(whereText(undefined)).toBe("");
  });
});
