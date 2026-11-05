// First to the host wins (SPEC §23.1). The host remembers, for every property
// of every object, which commit last changed it and who made it; a proposal
// based on an older state loses the properties someone else changed since.
// A delete loses to any change by someone else to the object or to what it
// holds (a timeline's tracks, items and markers, a bin's clips and so on).

import type { SessionModel, SessionOp } from "./session-model.ts";

interface Change {
  seq: number;
  author: string;
}

export type RaceResult =
  | { ok: true; op: SessionOp; lost: string[] } // op without the lost properties
  | { ok: false; lost: string[] }; // nothing left: refused

const kindOf = (op: SessionOp) => op.type.slice(0, op.type.indexOf("."));
const verbOf = (op: SessionOp) => op.type.slice(op.type.indexOf(".") + 1);
const propsOf = (op: SessionOp) => Object.keys(op).filter((k) => k !== "type" && k !== "id");
// Maps of named values whose keys count as properties of their own, as the
// syncs track them (a clip's metadata, an item's transform properties).
const MAPS = new Set(["meta", "props"]);
const isMap = (field: string, value: unknown) => MAPS.has(field) && typeof value === "object" && value !== null && !Array.isArray(value);

// The op's properties as race keys: "color", or "meta:Scene" for a map entry.
function keysOf(op: SessionOp): string[] {
  const o = op as unknown as Record<string, unknown>;
  return propsOf(op).flatMap((p) => (isMap(p, o[p]) ? Object.keys(o[p] as object).map((k) => `${p}:${k}`) : [p]));
}

// The op without the given race keys.
function without(op: SessionOp, lost: string[]): SessionOp {
  const kept = { ...op } as Record<string, unknown>;
  for (const key of lost) {
    const at = key.indexOf(":");
    if (at < 0) {
      delete kept[key];
      continue;
    }
    const [map, entry] = [key.slice(0, at), key.slice(at + 1)];
    const rest = { ...(kept[map] as Record<string, unknown>) };
    delete rest[entry];
    if (Object.keys(rest).length) kept[map] = rest;
    else delete kept[map];
  }
  return kept as unknown as SessionOp;
}

export class Races {
  private readonly fields = new Map<string, Change>(); // kind:id:property
  private readonly objects = new Map<string, Change>(); // kind:id, the object or anything it holds

  // What the op may still do, given the state it was based on.
  check(op: SessionOp, author: string, base: number): RaceResult {
    const newer = (c: Change | undefined) => c !== undefined && c.seq > base && c.author !== author;
    const kind = kindOf(op);
    const id = (op as { id: string }).id;
    const verb = verbOf(op);
    if (verb === "delete") {
      return newer(this.objects.get(`${kind}:${id}`)) ? { ok: false, lost: ["*"] } : { ok: true, op, lost: [] };
    }
    if (verb !== "set") return { ok: true, op, lost: [] };
    const lost = keysOf(op).filter((p) => newer(this.fields.get(`${kind}:${id}:${p}`)));
    if (!lost.length) return { ok: true, op, lost };
    const kept = without(op, lost);
    if (!propsOf(kept).length) return { ok: false, lost };
    return { ok: true, op: kept, lost };
  }

  // Called with the model as it was BEFORE op was applied (a deleted object's
  // holders are still known then).
  record(model: SessionModel, op: SessionOp, author: string, seq: number): void {
    const change = { seq, author };
    const kind = kindOf(op);
    const id = (op as { id: string }).id;
    const verb = verbOf(op);
    if (verb === "set" || verb === "create") {
      for (const p of keysOf(op)) this.fields.set(`${kind}:${id}:${p}`, change);
    }
    if (verb !== "delete") this.objects.set(`${kind}:${id}`, change);
    for (const holder of holders(model, op)) this.objects.set(holder, change);
  }
}

// The objects that hold the op's object, innermost first: a change to an
// item is also a change to its track and timeline (SPEC §23.1).
function holders(model: SessionModel, op: SessionOp): string[] {
  const { pool, timelines } = model;
  const kind = kindOf(op);
  const o = op as unknown as Record<string, unknown>;
  const id = o.id as string;
  const out: string[] = [];
  const bins = (bin: string | undefined) => {
    for (let b = bin, guard = 0; b && pool.bins[b] && guard < 1000; b = pool.bins[b]!.parent, guard++) out.push(`bin:${b}`);
  };
  switch (kind) {
    case "bin":
      bins(pool.bins[id]?.parent ?? (o.parent as string | undefined));
      if (typeof o.parent === "string") bins(o.parent);
      break;
    case "clip": {
      bins(pool.clips[id]?.bin ?? (o.bin as string | undefined));
      if (typeof o.bin === "string") bins(o.bin);
      break;
    }
    case "poolmarker": {
      const clip = pool.markers[id]?.clip ?? (o.clip as string | undefined);
      if (clip) {
        out.push(`clip:${clip}`);
        bins(pool.clips[clip]?.bin);
      }
      break;
    }
    case "track": {
      const timeline = timelines.tracks[id]?.timeline ?? (o.timeline as string | undefined);
      if (timeline) out.push(`timeline:${timeline}`);
      break;
    }
    case "item": {
      const item = timelines.items[id];
      const timeline = item?.timeline ?? (o.timeline as string | undefined);
      for (const track of new Set([item?.track, o.track as string | undefined])) if (track) out.push(`track:${track}`);
      if (timeline) out.push(`timeline:${timeline}`);
      break;
    }
    case "marker": {
      const marker = timelines.markers[id];
      const timeline = marker?.timeline ?? (o.timeline as string | undefined);
      const item = marker?.item ?? (o.item as string | undefined);
      if (item) {
        out.push(`item:${item}`);
        const track = timelines.items[item]?.track;
        if (track) out.push(`track:${track}`);
      }
      if (timeline) out.push(`timeline:${timeline}`);
      break;
    }
  }
  return out;
}
