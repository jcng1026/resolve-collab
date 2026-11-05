// Ghost cursors in the project, not on the screen (SPEC §24.6.1). The layout
// watch reports where Resolve's panels are and what its timeline ruler and
// track names say; this turns a pointer into a spot both PCs understand (a
// panel and a spot in it; on the timeline, a frame and a track), and a spot
// back into this PC's screen. Everything here is screen pixels.

export type Rect = [number, number, number, number]; // left, top, width, height

export const PANELS = ["mediapool", "toolbox", "viewer", "inspector", "timeline"] as const;
export type Panel = (typeof PANELS)[number];

// One piece of text the OCR read: a word on the ruler, or a line of track names.
export interface Text { text: string; x: number; y: number; w: number; h: number }

export interface ScreenLayout {
  window: Rect; // Resolve's window
  panels: Partial<Record<Panel, Rect>>;
  ruler: Text[]; // words on the timeline's ruler strip
  heads: Text[]; // lines in the track-name column
  scale: number; // screen pixels per Resolve layout pixel (Windows' display scale)
}

// What a pointer means: the panel, its spot in it (0–1), and on the timeline
// its frame (from 00:00:00:00), track ("V1", "A2") and how far below the
// track's name, in heights of that name.
export interface Spot { panel: Panel | "window"; u: number; v: number; frame?: number; track?: string; dy?: number }

export interface Track { kind: "video" | "audio"; order: number; name: string }

// Resolve's timeline at 100% display scale: the track header column's width
// and the ruler's height. shortcut: fixed, measured on Resolve 21.1.2.
const HEADER = 260;
const RULER = 26;
const TICK = 6; // a ruler label starts this far right of its tick
const NAME_BELOW_TOP = 32; // a track's name sits this far below the track's top edge

interface Ruler { x0: number; frame0: number; perFrame: number }

const box = (r: Rect, x: number, y: number) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// The timeline's area right of the track names and below the ruler.
function contentOf(tl: Rect, scale: number): Rect {
  const left = HEADER * scale;
  const top = RULER * scale;
  return [tl[0] + left, tl[1] + top, Math.max(0, tl[2] - left), Math.max(0, tl[3] - top)];
}

// Where each frame is, from at least two timecodes read off the ruler, evenly spaced.
export function readRuler(words: Text[], fps: number, content: Rect, scale: number): Ruler | undefined {
  const rate = Math.round(fps);
  if (!(rate > 0)) return undefined;
  // The OCR splits "01:00:08:00" into pieces; join pieces on one line that touch.
  const sorted = words.filter((w) => w.x >= content[0] - 2).sort((a, b) => a.x - b.x);
  const joined: Text[] = [];
  for (const w of sorted) {
    const last = joined.at(-1);
    if (last && Math.abs(last.y - w.y) < Math.max(last.h, w.h) / 2 + 1 && w.x - (last.x + last.w) < 1.5 * Math.max(last.h, w.h, 8)) {
      joined[joined.length - 1] = { ...last, text: last.text + w.text, w: w.x + w.w - last.x };
    } else joined.push(w);
  }
  const labels = joined.flatMap((w) => {
    const d = w.text.replace(/\D/g, "");
    if (d.length !== 8) return [];
    const [h, m, s, f] = [0, 2, 4, 6].map((i) => Number(d.slice(i, i + 2)));
    if (m! > 59 || s! > 59 || f! >= rate) return [];
    return [{ x: w.x - TICK * scale, frame: ((h! * 60 + m!) * 60 + s!) * rate + f! }];
  });
  if (labels.length < 2) return undefined;
  const first = labels[0]!;
  const last = labels.at(-1)!;
  if (last.frame <= first.frame) return undefined;
  const perFrame = (last.x - first.x) / (last.frame - first.frame);
  const spacing = (last.x - first.x) / (labels.length - 1);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.frame <= labels[i - 1]!.frame) return undefined;
  for (const l of labels) if (Math.abs(first.x + (l.frame - first.frame) * perFrame - l.x) > Math.max(3, spacing * 0.03)) return undefined;
  return { x0: first.x, frame0: first.frame, perFrame };
}

// Each track's name on screen, matched by name to the timeline's tracks; a
// name two tracks share, or one not read, is left out.
export function trackRows(heads: Text[], tracks: Track[]): Map<string, { y: number; h: number }> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rows = new Map<string, { y: number; h: number }>();
  const byName = new Map<string, Track[]>();
  for (const t of tracks) byName.set(norm(t.name), [...(byName.get(norm(t.name)) ?? []), t]);
  for (const line of heads) {
    const same = byName.get(norm(line.text));
    if (same?.length !== 1) continue;
    const key = `${same[0]!.kind === "video" ? "V" : "A"}${same[0]!.order}`;
    if (!rows.has(key)) rows.set(key, { y: line.y, h: Math.max(1, line.h) });
  }
  return rows;
}

// What this PC knows about its own screen, worked out once per change.
export interface Placed {
  layout: ScreenLayout;
  ruler: Ruler | undefined;
  rows: Map<string, { y: number; h: number }>;
  content: Rect | undefined;
}

export function prepare(layout: ScreenLayout, fps: number, tracks: Track[]): Placed {
  const tl = layout.panels.timeline;
  const content = tl && contentOf(tl, layout.scale);
  return {
    layout,
    ruler: content ? readRuler(layout.ruler, fps, content, layout.scale) : undefined,
    rows: trackRows(layout.heads, tracks),
    content,
  };
}

// A pointer on this PC's screen, as a spot for the others.
export function locate(p: Placed, x: number, y: number): Spot | undefined {
  const { layout } = p;
  if (!box(layout.window, x, y)) return undefined;
  for (const panel of PANELS) {
    const r = layout.panels[panel];
    if (!r || !box(r, x, y)) continue;
    const spot: Spot = { panel, u: clamp01((x - r[0]) / r[2]), v: clamp01((y - r[1]) / r[3]) };
    if (panel === "timeline" && p.content && box(p.content, x, y)) {
      if (p.ruler) spot.frame = Math.round(p.ruler.frame0 + (x - p.ruler.x0) / p.ruler.perFrame);
      // The lowest track whose top edge is above the pointer.
      let best: [string, { y: number; h: number }] | undefined;
      for (const row of p.rows) if (row[1].y - NAME_BELOW_TOP * layout.scale <= y && (!best || row[1].y > best[1].y)) best = row;
      if (best) Object.assign(spot, { track: best[0], dy: (y - best[1].y) / best[1].h });
    }
    return spot;
  }
  const w = layout.window;
  return { panel: "window", u: clamp01((x - w[0]) / w[2]), v: clamp01((y - w[1]) / w[3]) };
}

const tc = (frame: number, fps: number) => {
  const r = Math.max(1, Math.round(fps));
  const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${two(frame / (3600 * r))}:${two((frame / (60 * r)) % 60)}:${two((frame / r) % 60)}:${two(frame % r)}`;
};

// A spot from another PC, on this PC's screen; undefined when this PC doesn't
// show that panel. `edge` and `hint` when its frame is outside this PC's view.
export function place(p: Placed, s: Spot, fps: number, sameTimeline: boolean): { x: number; y: number; edge?: "left" | "right"; hint?: string } | undefined {
  const r = s.panel === "window" ? p.layout.window : p.layout.panels[s.panel];
  if (!r) return undefined;
  let x = r[0] + s.u * r[2];
  let y = r[1] + s.v * r[3];
  const c = p.content;
  if (s.panel !== "timeline" || !c || !sameTimeline) return { x, y };
  const row = s.track && s.dy !== undefined ? p.rows.get(s.track) : undefined;
  if (row) y = row.y + s.dy! * row.h;
  if (p.ruler && s.frame !== undefined) x = p.ruler.x0 + (s.frame - p.ruler.frame0) * p.ruler.perFrame;
  if (row || (p.ruler && s.frame !== undefined)) y = Math.min(c[1] + c[3] - 1, Math.max(c[1], y));
  if (s.frame === undefined || !p.ruler) return { x, y };
  if (x < c[0]) return { x: c[0], y, edge: "left", hint: `← ${tc(s.frame, fps)}` };
  if (x > c[0] + c[2] - 1) return { x: c[0] + c[2] - 1, y, edge: "right", hint: `→ ${tc(s.frame, fps)}` };
  return { x, y };
}

// A spot as another PC sent it, checked (SPEC §13: peers send data).
export function cleanSpot(v: unknown): Spot | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const in01 = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
  if (!(o.panel === "window" || PANELS.includes(o.panel as Panel)) || !in01(o.u) || !in01(o.v)) return undefined;
  const spot: Spot = { panel: o.panel as Spot["panel"], u: o.u as number, v: o.v as number };
  if (Number.isInteger(o.frame) && (o.frame as number) >= 0 && (o.frame as number) < 1e9) spot.frame = o.frame as number;
  if (typeof o.track === "string" && /^[VA]\d{1,3}$/.test(o.track) && typeof o.dy === "number" && Math.abs(o.dy) <= 100) {
    spot.track = o.track;
    spot.dy = o.dy;
  }
  return spot;
}
