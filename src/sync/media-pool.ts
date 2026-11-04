// The session's model of the media pool and the operations that change it
// (SPEC §19.2). Operations set values, so applying one twice changes nothing.
// Everything here may come from a peer, so validateOp checks shape and
// references before anything is applied.

import { MAX_MARKERS_PER_OWNER, type MarkerFields, type MarkerValues, checkMarker, checkMarkerFields } from "./marker.ts";

export const ROOT = "root";

export interface Bin {
  id: string;
  name: string;
  parent: string; // "" for the root bin
}

export interface Fingerprint {
  name: string;
  size: number;
  hash: string;
}

export interface Clip {
  id: string;
  name: string;
  bin: string;
  color: string; // "" when none
  flags: string[]; // sorted
  meta: Record<string, string>; // only non-empty values
  file: Fingerprint | null;
}

// A marker on a media pool clip (SPEC §21.2), at a source frame.
export interface PoolMarker extends MarkerValues {
  id: string;
  clip: string;
}

export interface MediaPool {
  bins: Record<string, Bin>;
  clips: Record<string, Clip>;
  markers: Record<string, PoolMarker>;
}

export type BinFields = Partial<Pick<Bin, "name" | "parent">>;
export type ClipFields = Partial<Pick<Clip, "name" | "bin" | "color" | "flags">> & {
  meta?: Record<string, string>; // "" unsets a key
};

export type Op =
  | ({ type: "bin.create" } & Bin)
  | ({ type: "bin.set"; id: string } & BinFields)
  | { type: "bin.delete"; id: string }
  | ({ type: "clip.create" } & Clip)
  | ({ type: "clip.set"; id: string } & ClipFields)
  | { type: "clip.delete"; id: string }
  | ({ type: "poolmarker.create" } & PoolMarker)
  | ({ type: "poolmarker.set"; id: string } & MarkerFields)
  | { type: "poolmarker.delete"; id: string };

export function emptyPool(): MediaPool {
  return { bins: { [ROOT]: { id: ROOT, name: "Master", parent: "" } }, clips: {}, markers: {} };
}

export function clonePool(pool: MediaPool): MediaPool {
  return structuredClone(pool);
}

export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

// Limits keep one peer from bloating everyone's project.
const MAX_NAME = 255;
const MAX_META_KEYS = 200;
const MAX_META_VALUE = 4096;
const MAX_FLAGS = 16;

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const isBinRef = (v: unknown): v is string => v === ROOT || isId(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME && !/[\u0000-\u001f]/.test(v);
const isColor = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z ]{0,32}$/.test(v);

function checkFlags(v: unknown): string | null {
  if (!Array.isArray(v) || v.length > MAX_FLAGS || !v.every(isColor)) return "bad flags";
  return null;
}

function checkMeta(v: unknown, allowEmpty: boolean): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "bad meta";
  const entries = Object.entries(v);
  if (entries.length > MAX_META_KEYS) return "too many meta keys";
  for (const [key, value] of entries) {
    if (!isName(key) || typeof value !== "string" || value.length > MAX_META_VALUE) return `bad meta ${key}`;
    if (!allowEmpty && value === "") return `empty meta ${key}`;
  }
  return null;
}

function checkFile(v: unknown): string | null {
  if (v === null) return null;
  const f = v as Fingerprint;
  // The name is joined to local folders when looking for the file, so it must
  // be a bare file name.
  const plainName = isName(f.name) && !/[\\/:]/.test(f.name) && f.name !== "." && f.name !== "..";
  if (typeof f !== "object" || !plainName || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(String(f.hash))) {
    return "bad file";
  }
  return null;
}

function isInside(pool: MediaPool, bin: string, ancestor: string): boolean {
  for (let at: string | undefined = bin; at; at = pool.bins[at]?.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

// Returns why op can't be applied to pool, or null when it can. Deleting
// something already gone is allowed (a no-op), since deletes cascade.
// `frames`: one marker per frame per clip (SPEC §21.2); whole models aren't
// held to it.
export function validateOp(pool: MediaPool, op: unknown, frames = true): string | null {
  const o = op as Op;
  if (typeof o !== "object" || o === null) return "not an object";
  switch (o.type) {
    case "bin.create":
      if (!isId(o.id) || pool.bins[o.id]) return "bad or existing bin id";
      if (!isName(o.name)) return "bad name";
      if (!pool.bins[o.parent]) return "unknown parent";
      return null;
    case "bin.set":
      if (!isId(o.id) || !pool.bins[o.id]) return "unknown bin";
      if (o.name !== undefined && !isName(o.name)) return "bad name";
      if (o.parent !== undefined) {
        if (!pool.bins[o.parent]) return "unknown parent";
        if (isInside(pool, o.parent, o.id)) return "bin can't move into itself";
      }
      return null;
    case "bin.delete":
      return isId(o.id) ? null : "bad bin id";
    case "clip.create":
      if (!isId(o.id) || pool.clips[o.id]) return "bad or existing clip id";
      if (!isName(o.name) || !pool.bins[o.bin] || !isColor(o.color)) return "bad clip";
      return checkFlags(o.flags) ?? checkMeta(o.meta, false) ?? checkFile(o.file);
    case "clip.set":
      if (!isId(o.id) || !pool.clips[o.id]) return "unknown clip";
      if (o.name !== undefined && !isName(o.name)) return "bad name";
      if (o.bin !== undefined && !pool.bins[o.bin]) return "unknown bin";
      if (o.color !== undefined && !isColor(o.color)) return "bad color";
      if (o.flags !== undefined && checkFlags(o.flags)) return "bad flags";
      if (o.meta !== undefined) return checkMeta(o.meta, true);
      return null;
    case "clip.delete":
      return isId(o.id) ? null : "bad clip id";
    case "poolmarker.create": {
      if (!isId(o.id) || pool.markers[o.id]) return "bad or existing marker id";
      if (!pool.clips[o.clip]) return "unknown clip";
      const same = Object.values(pool.markers).filter((m) => m.clip === o.clip);
      if (same.length >= MAX_MARKERS_PER_OWNER) return "too many markers";
      if (frames && same.some((m) => m.frame === o.frame)) return "occupied";
      return checkMarker(o);
    }
    case "poolmarker.set": {
      const marker = isId(o.id) ? pool.markers[o.id] : undefined;
      if (!marker) return "unknown marker";
      const taken = (m: PoolMarker) => m.id !== marker.id && m.clip === marker.clip && m.frame === o.frame;
      if (frames && o.frame !== undefined && Object.values(pool.markers).some(taken)) return "occupied";
      return checkMarkerFields(o);
    }
    case "poolmarker.delete":
      return isId(o.id) ? null : "bad marker id";
    default:
      return "unknown op";
  }
}

function deleteClip(pool: MediaPool, id: string): void {
  delete pool.clips[id];
  for (const m of Object.values(pool.markers)) if (m.clip === id) delete pool.markers[m.id];
}

// Applies a valid op in place.
export function applyOp(pool: MediaPool, op: Op): void {
  switch (op.type) {
    case "bin.create":
      pool.bins[op.id] = { id: op.id, name: op.name, parent: op.parent };
      return;
    case "bin.set": {
      const bin = pool.bins[op.id]!;
      if (op.name !== undefined) bin.name = op.name;
      if (op.parent !== undefined) bin.parent = op.parent;
      return;
    }
    case "bin.delete": {
      if (!pool.bins[op.id] || op.id === ROOT) return;
      const doomed = new Set(Object.keys(pool.bins).filter((id) => isInside(pool, id, op.id)));
      for (const id of doomed) delete pool.bins[id];
      for (const clip of Object.values(pool.clips)) if (doomed.has(clip.bin)) deleteClip(pool, clip.id);
      return;
    }
    case "clip.create":
      pool.clips[op.id] = {
        id: op.id, name: op.name, bin: op.bin, color: op.color, flags: [...op.flags].sort(),
        meta: { ...op.meta }, file: op.file && { ...op.file },
      };
      return;
    case "clip.set": {
      const clip = pool.clips[op.id]!;
      if (op.name !== undefined) clip.name = op.name;
      if (op.bin !== undefined) clip.bin = op.bin;
      if (op.color !== undefined) clip.color = op.color;
      if (op.flags !== undefined) clip.flags = [...op.flags].sort();
      for (const [key, value] of Object.entries(op.meta ?? {})) {
        if (value === "") delete clip.meta[key];
        else clip.meta[key] = value;
      }
      return;
    }
    case "clip.delete":
      deleteClip(pool, op.id);
      return;
    case "poolmarker.create": {
      const { type: _, ...marker } = op;
      pool.markers[op.id] = { ...marker };
      return;
    }
    case "poolmarker.set": {
      const { type: _, id: __, ...fields } = op;
      Object.assign(pool.markers[op.id]!, fields);
      return;
    }
    case "poolmarker.delete":
      delete pool.markers[op.id];
      return;
  }
}

// Bin path from the root, e.g. "/Footage/Day 1/"; used to match bins between
// projects that don't share IDs.
export function binPath(pool: MediaPool, id: string): string {
  const names: string[] = [];
  for (let at = pool.bins[id]; at && at.id !== ROOT; at = pool.bins[at.parent]) names.unshift(at.name);
  return `/${names.map((n) => `${n}/`).join("")}`;
}

// Rebuilds a whole model received from a peer through validateOp, so it is
// held to the same checks as single operations. Returns null if any part fails.
export function validatePool(input: unknown): MediaPool | null {
  const raw = input as MediaPool;
  if (typeof raw !== "object" || raw === null || typeof raw.bins !== "object" || typeof raw.clips !== "object") return null;
  const pool = emptyPool();
  const bins = Object.values(raw.bins ?? {}).filter((b) => b?.id !== ROOT);
  // Parents first: keep passing over the rest while any bin gets placed.
  let placed = true;
  while (bins.length && placed) {
    placed = false;
    for (let i = bins.length - 1; i >= 0; i--) {
      const b = bins[i]!;
      if (!pool.bins[b.parent]) continue;
      const op = { type: "bin.create", id: b.id, name: b.name, parent: b.parent } as const;
      if (validateOp(pool, op)) return null;
      applyOp(pool, op);
      bins.splice(i, 1);
      placed = true;
    }
  }
  if (bins.length) return null;
  for (const c of Object.values(raw.clips ?? {})) {
    const op = { type: "clip.create", id: c?.id, name: c?.name, bin: c?.bin, color: c?.color, flags: c?.flags, meta: c?.meta, file: c?.file } as Op;
    if (validateOp(pool, op)) return null;
    applyOp(pool, op);
  }
  // Saved before M5: no markers.
  for (const m of Object.values(raw.markers ?? {})) {
    const op = { type: "poolmarker.create", id: m?.id, clip: m?.clip, frame: m?.frame, duration: m?.duration, color: m?.color, name: m?.name, note: m?.note } as Op;
    if (validateOp(pool, op, false)) return null;
    applyOp(pool, op);
  }
  return pool;
}
