// Undo and redo of this PC's own changes (SPEC §23.2). A step is everything
// proposed from one detected change; each committed operation adds its
// inverse, worked out from the session state just before it was applied.
// History is per session, the last 100 steps, saved in sessions/<id>/undo.json.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type SessionModel, type SessionOp, applySessionOp, cloneModel } from "./sync/session-model.ts";

export const MAX_STEPS = 100;

export interface Step {
  forward: SessionOp[]; // as committed, in order
  inverse: SessionOp[]; // undoes them, in the order to send
}

type Table = Record<string, Record<string, unknown>>;

// The kinds, in the order things must exist in: what holds comes first.
const TABLES: { kind: string; get: (m: SessionModel) => Table }[] = [
  { kind: "bin", get: (m) => m.pool.bins as unknown as Table },
  { kind: "clip", get: (m) => m.pool.clips as unknown as Table },
  { kind: "poolmarker", get: (m) => m.pool.markers as unknown as Table },
  { kind: "timeline", get: (m) => m.timelines.timelines as unknown as Table },
  { kind: "track", get: (m) => m.timelines.tracks as unknown as Table },
  { kind: "item", get: (m) => m.timelines.items as unknown as Table },
  { kind: "marker", get: (m) => m.timelines.markers as unknown as Table },
];
const tableOf = (m: SessionModel, kind: string) => TABLES.find((t) => t.kind === kind)?.get(m);
const MAPS = new Set(["meta", "props"]);

// The operations that put `before` back after `op` (not yet applied to it).
export function inverseOf(before: SessionModel, op: SessionOp): SessionOp[] {
  const type = op.type;
  const kind = type.slice(0, type.indexOf("."));
  const id = (op as { id: string }).id;
  const table = tableOf(before, kind);
  if (!table) return [];
  if (type.endsWith(".create")) return [{ type: `${kind}.delete`, id } as SessionOp];
  if (type.endsWith(".set")) {
    const old = table[id];
    if (!old) return [];
    const back: Record<string, unknown> = { type: `${kind}.set`, id };
    for (const [field, value] of Object.entries(op)) {
      if (field === "type" || field === "id") continue;
      if (MAPS.has(field) && value && typeof value === "object" && !Array.isArray(value)) {
        const was = (old[field] ?? {}) as Record<string, unknown>;
        const entries: Record<string, unknown> = {};
        // A metadata key that wasn't set is unset again with "".
        for (const k of Object.keys(value)) {
          if (was[k] !== undefined) entries[k] = structuredClone(was[k]);
          else if (field === "meta") entries[k] = "";
        }
        if (Object.keys(entries).length) back[field] = entries;
      } else if (old[field] !== undefined) {
        back[field] = structuredClone(old[field]);
      }
    }
    return Object.keys(back).length > 2 ? [back as unknown as SessionOp] : [];
  }
  // A delete: whatever it removed (with what was inside) comes back, and what
  // it shifted (tracks above a deleted track) moves back first.
  const after = cloneModel(before);
  applySessionOp(after, op);
  const sets: SessionOp[] = [];
  const creates: SessionOp[] = [];
  for (const { kind: k, get } of TABLES) {
    const was = get(before);
    const now = get(after);
    const gone = Object.keys(was).filter((i) => !now[i]);
    for (const i of order(k, gone, was)) creates.push({ type: `${k}.create`, ...structuredClone(was[i]) } as unknown as SessionOp);
    for (const i of Object.keys(now)) {
      const changed: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(was[i]!)) if (f !== "id" && JSON.stringify(v) !== JSON.stringify(now[i]![f])) changed[f] = structuredClone(v);
      if (Object.keys(changed).length) sets.push({ type: `${k}.set`, id: i, ...changed } as unknown as SessionOp);
    }
  }
  return [...sets, ...creates];
}

// Bins parent first; transitions after the clips they sit on.
function order(kind: string, ids: string[], table: Table): string[] {
  if (kind === "bin") {
    const depth = (i: string): number => {
      let d = 0;
      for (let p = table[i]?.parent as string | undefined; p && table[p] && d < 1000; p = table[p]!.parent as string) d++;
      return d;
    };
    return [...ids].sort((a, b) => depth(a) - depth(b));
  }
  if (kind === "item") return [...ids].sort((a, b) => Number(table[a]!.kind === "transition") - Number(table[b]!.kind === "transition"));
  return ids;
}

// In Resolve a media pool clip's colour also colours its clips on timelines,
// so a clip recoloured (by anyone, or by an undo) makes its items change too.
// That follows the clip; it isn't a step of this person's own.
export function followsClipColor(op: SessionOp, model: SessionModel, localColor: (clip: string) => string | undefined): boolean {
  if (op.type !== "item.set") return false;
  const { type: _, id, color, ...rest } = op as { type: string; id: string; color?: string };
  if (color === undefined || Object.keys(rest).length) return false;
  const media = model.timelines.items[id]?.media;
  return !!media && (model.pool.clips[media]?.color === color || localColor(media) === color);
}

export class History {
  undo: Step[] = [];
  redo: Step[] = [];
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { undo?: unknown; redo?: unknown };
      const steps = (v: unknown) => (Array.isArray(v) ? v.filter(isStep).slice(-MAX_STEPS) : []);
      this.undo = steps(raw.undo);
      this.redo = steps(raw.redo);
    } catch {
      // A damaged file starts the history afresh.
    }
  }

  // A new step of this PC's own; a fresh change clears what could be redone.
  push(step: Step, clearRedo: boolean): void {
    this.undo.push(step);
    if (this.undo.length > MAX_STEPS) this.undo.splice(0, this.undo.length - MAX_STEPS);
    if (clearRedo) this.redo = [];
  }

  save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ undo: this.undo, redo: this.redo }));
    renameSync(tmp, this.file);
  }
}

function isStep(v: unknown): v is Step {
  const s = v as Step;
  const ops = (a: unknown) => Array.isArray(a) && a.every((o) => typeof o === "object" && o !== null && typeof (o as { type?: unknown }).type === "string");
  return typeof s === "object" && s !== null && ops(s.forward) && ops(s.inverse);
}
