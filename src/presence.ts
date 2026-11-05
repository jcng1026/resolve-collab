// Where each person is in Resolve (SPEC §8): their page, timeline, playhead
// and the clip under it. The bridge reports this PC's; the host passes
// everyone's on to everyone, with each person's colour (SPEC §24.4).

export interface Presence {
  page: string;
  timeline: string; // collab ID of their current timeline, "" if none
  timelineName: string;
  timecode: string;
  clip: string; // the clip under the playhead, "" if none
}

export interface Person {
  id: string; // peer ID
  name: string;
  color: string;
  online: boolean;
  presence?: Presence;
}

// Apple's dark-mode system colours, in join order (the host is first); the
// accessible variants where the plain one is too dark on the panel (§24.4).
export const PALETTE = ["#409CFF", "#FF9F0A", "#30D158", "#FF375F", "#40C8E0", "#FFD60A", "#7D7AFF", "#FF453A", "#66D4CF", "#64D2FF"];
export const colorAt = (index: number) => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;

const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

// A presence from the bridge or a peer, checked field by field; undefined if malformed.
export function cleanPresence(raw: unknown): Presence | undefined {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) return undefined;
  const page = text(r.page, 20);
  const timeline = text(r.timeline, 64);
  const timelineName = text(r.timelineName, 255);
  const timecode = text(r.timecode, 32);
  const clip = text(r.clip, 255);
  if (page === undefined || timeline === undefined || timelineName === undefined || timecode === undefined || clip === undefined) return undefined;
  return { page, timeline, timelineName, timecode, clip };
}

// A people list from the host, checked; undefined if malformed.
export function cleanPeople(raw: unknown): Person[] | undefined {
  if (!Array.isArray(raw) || raw.length > 64) return undefined;
  const people: Person[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const id = text(p?.id, 64);
    const name = text(p?.name, 40);
    const color = typeof p?.color === "string" && PALETTE.includes(p.color) ? p.color : undefined;
    if (!id || name === undefined || !color || typeof p.online !== "boolean") return undefined;
    people.push({ id, name, color, online: p.online });
  }
  return people;
}

// "Edit · Timeline 1 · 01:02:14:05 · Interview_03" for a person's line.
export function whereText(p: Presence | undefined): string {
  if (!p) return "";
  const page = p.page ? p.page[0]!.toUpperCase() + p.page.slice(1) : "";
  return [page, p.timelineName, p.timecode, p.clip].filter(Boolean).join(" · ");
}
