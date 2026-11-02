// The reconciler (SPEC §19.5): compares, for every bin, clip and field, the
// last agreed value (base), Resolve now (local) and the session (host's
// model), and decides what to propose, what to apply locally, and what to
// ask the user. Pure: callers carry out the plan.

import { type Bin, type Clip, type MediaPool, type Op, ROOT, clonePool } from "./media-pool.ts";

export type Kind = "bin" | "clip";
export type Mode = "live" | "catch-up";

export interface Conflict {
  key: string;
  kind: "field" | "deleted-here" | "deleted-there";
  item: Kind;
  id: string;
  label: string; // the item's name, for the question
  field?: string;
  mine?: unknown;
  theirs?: unknown;
}

export type Answer = "mine" | "theirs";

export interface ReconcileInput {
  base: MediaPool | null; // null on first join: nothing agreed yet
  local: MediaPool;
  session: MediaPool;
  mode: Mode;
  // Proposals in flight: field key (see fieldKey) → proposed value.
  pending: ReadonlyMap<string, unknown>;
  // Items with a bridge command in flight ("clip:<id>"); left alone.
  busy: ReadonlySet<string>;
}

export interface Plan {
  propose: Op[];
  apply: Op[]; // session values to bring into Resolve
  conflicts: Conflict[]; // need an answer (catch-up, or a delete race)
  overwritten: Conflict[]; // live races the session won; the user is told
  base: MediaPool;
}

export const itemKey = (item: Kind, id: string) => `${item}:${id}`;
export const fieldKey = (item: Kind, id: string, field: string) => `${item}:${id}:${field}`;
// Existence (create/delete) is tracked as the pseudo-field "*".
export const EXISTS = "*";

type Fields = Record<string, unknown>;

function binFields(bin: Bin): Fields {
  return { name: bin.name, parent: bin.parent };
}

function clipFields(clip: Clip): Fields {
  const fields: Fields = { name: clip.name, bin: clip.bin, color: clip.color, flags: clip.flags };
  for (const [key, value] of Object.entries(clip.meta)) fields[`meta:${key}`] = value;
  return fields;
}

function fieldsOf(item: Kind, value: Bin | Clip | undefined): Fields | undefined {
  if (!value) return undefined;
  return item === "bin" ? binFields(value as Bin) : clipFields(value as Clip);
}

// A missing meta key reads as "" (unset).
function get(fields: Fields | undefined, field: string): unknown {
  const value = fields?.[field];
  return value === undefined && field.startsWith("meta:") ? "" : value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setOp(item: Kind, id: string, changes: Fields): Op {
  if (item === "bin") return { type: "bin.set", id, ...changes } as Op;
  const meta: Record<string, string> = {};
  const rest: Fields = {};
  for (const [field, value] of Object.entries(changes)) {
    if (field.startsWith("meta:")) meta[field.slice(5)] = value as string;
    else rest[field] = value;
  }
  return { type: "clip.set", id, ...rest, ...(Object.keys(meta).length ? { meta } : {}) } as Op;
}

function createOp(item: Kind, value: Bin | Clip): Op {
  return item === "bin" ? { type: "bin.create", ...(value as Bin) } : { type: "clip.create", ...structuredClone(value as Clip) };
}

function deleteOp(item: Kind, id: string): Op {
  return { type: item === "bin" ? "bin.delete" : "clip.delete", id };
}

// Rebuilds an item from its base, overriding the given fields.
function withFields<T extends Bin | Clip>(item: Kind, original: T, fields: Fields): T {
  const out = structuredClone(original) as T;
  if (item === "clip") (out as Clip).meta = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field.startsWith("meta:")) {
      if (value !== "") (out as Clip).meta[field.slice(5)] = value as string;
    } else {
      (out as unknown as Fields)[field] = structuredClone(value);
    }
  }
  return out;
}

function depth(pool: MediaPool, id: string): number {
  let n = 0;
  for (let at = pool.bins[id]; at && at.id !== ROOT; at = pool.bins[at.parent]) n++;
  return n;
}

// True if any bin above item (in pool) is in the deleted set: the cascade
// already covers it.
function coveredByDelete(pool: MediaPool, item: Kind, id: string, deletedBins: Set<string>): boolean {
  let at = item === "bin" ? pool.bins[id]?.parent : pool.clips[id]?.bin;
  for (; at; at = pool.bins[at]?.parent) if (deletedBins.has(at)) return true;
  return false;
}

export function reconcile(input: ReconcileInput): Plan {
  const { local, session, mode, pending, busy } = input;
  const base = input.base ?? { bins: {}, clips: {} };
  const firstJoin = input.base === null;
  const plan: Plan = { propose: [], apply: [], conflicts: [], overwritten: [], base: clonePool(base) };
  const proposedDeletes = { bin: new Set<string>(), clip: new Set<string>() };
  const appliedDeletes = { bin: new Set<string>(), clip: new Set<string>() };

  for (const item of ["bin", "clip"] as const) {
    const table = (pool: MediaPool) => (item === "bin" ? pool.bins : pool.clips) as Record<string, Bin | Clip>;
    const ids = new Set([...Object.keys(table(base)), ...Object.keys(table(local)), ...Object.keys(table(session))]);
    ids.delete(ROOT);
    for (const id of ids) {
      if (busy.has(itemKey(item, id))) continue;
      const b = table(base)[id];
      const l = table(local)[id];
      const s = table(session)[id];
      const baseTable = table(plan.base);
      const label = (l ?? s ?? b)!.name;
      const existsKey = fieldKey(item, id, EXISTS);

      if (!l && !s) {
        delete baseTable[id];
        continue;
      }
      if (l && !s) {
        if (!b) {
          if (!pending.has(existsKey)) plan.propose.push(createOp(item, l));
        } else if (pending.has(existsKey)) {
          // our own re-create is in flight
        } else if (same(fieldsOf(item, l), fieldsOf(item, b))) {
          plan.apply.push(deleteOp(item, id));
          appliedDeletes[item].add(id);
        } else {
          plan.conflicts.push({ key: existsKey, kind: "deleted-there", item, id, label });
        }
        continue;
      }
      if (!l && s) {
        if (!b) {
          plan.apply.push(createOp(item, s));
        } else if (pending.has(existsKey)) {
          // our delete is in flight
        } else if (same(fieldsOf(item, s), fieldsOf(item, b))) {
          plan.propose.push(deleteOp(item, id));
          proposedDeletes[item].add(id);
        } else {
          plan.conflicts.push({ key: existsKey, kind: "deleted-here", item, id, label });
        }
        continue;
      }

      // On both sides: compare field by field.
      const lf = fieldsOf(item, l)!;
      const sf = fieldsOf(item, s)!;
      const bf = fieldsOf(item, b);
      const proposeChanges: Fields = {};
      const applyChanges: Fields = {};
      const agreed: Fields = {};
      for (const field of new Set([...Object.keys(lf), ...Object.keys(sf), ...Object.keys(bf ?? {})])) {
        const lv = get(lf, field);
        const sv = get(sf, field);
        const key = fieldKey(item, id, field);
        if (same(lv, sv)) {
          agreed[field] = lv;
          continue;
        }
        // Nothing agreed yet (first join, or not yet seen on both sides):
        // the session's value wins.
        const bv = bf && !firstJoin ? get(bf, field) : lv;
        agreed[field] = bv;
        if (same(lv, bv)) {
          applyChanges[field] = sv;
        } else if (same(sv, bv)) {
          if (!pending.has(key) || !same(pending.get(key), lv)) proposeChanges[field] = lv;
        } else if (pending.has(key)) {
          // our proposal for this field is in flight and will be committed later
        } else if (mode === "live") {
          applyChanges[field] = sv;
          plan.overwritten.push({ key, kind: "field", item, id, label, field, mine: lv, theirs: sv });
        } else {
          plan.conflicts.push({ key, kind: "field", item, id, label, field, mine: lv, theirs: sv });
        }
      }
      if (Object.keys(proposeChanges).length) plan.propose.push(setOp(item, id, proposeChanges));
      if (Object.keys(applyChanges).length) plan.apply.push(setOp(item, id, applyChanges));
      baseTable[id] = withFields(item, s!, agreed);
    }
  }

  // Proposed deletes are gone locally, so their bins are looked up in base.
  plan.propose = order(plan.propose, local, proposedDeletes, base);
  plan.apply = order(plan.apply, session, appliedDeletes, local);
  return plan;
}

// Creates parent-first (depth in `created`); sets; deletes last, leaving out
// ones a bin delete already covers (ancestry in `where`).
function order(ops: Op[], created: MediaPool, deleted: { bin: Set<string>; clip: Set<string> }, where: MediaPool): Op[] {
  const rank = (op: Op) => ["bin.create", "bin.set", "clip.create", "clip.set", "clip.delete", "bin.delete"].indexOf(op.type);
  return ops
    .filter((op) => {
      if (op.type === "bin.delete") return !coveredByDelete(where, "bin", op.id, deleted.bin);
      if (op.type === "clip.delete") return !coveredByDelete(where, "clip", op.id, deleted.bin);
      return true;
    })
    .sort((a, b) => rank(a) - rank(b) || (a.type === "bin.create" && b.type === "bin.create" ? depth(created, a.id) - depth(created, b.id) : 0));
}

// Turns answers into operations. Unanswered conflicts are left out.
export function resolveConflicts(
  conflicts: Conflict[],
  answers: ReadonlyMap<string, Answer>,
  local: MediaPool,
  session: MediaPool,
): { propose: Op[]; apply: Op[] } {
  const propose: Op[] = [];
  const apply: Op[] = [];
  for (const c of conflicts) {
    const answer = answers.get(c.key);
    if (!answer) continue;
    const l = (c.item === "bin" ? local.bins : local.clips)[c.id];
    const s = (c.item === "bin" ? session.bins : session.clips)[c.id];
    if (c.kind === "field") {
      const changes = { [c.field!]: answer === "mine" ? c.mine : c.theirs };
      (answer === "mine" ? propose : apply).push(setOp(c.item, c.id, changes));
    } else if (c.kind === "deleted-here") {
      // mine = it stays deleted; theirs = bring their version back here
      if (answer === "mine") propose.push(deleteOp(c.item, c.id));
      else if (s) apply.push(createOp(c.item, s));
    } else {
      // deleted-there: mine = keep my edited version for everyone
      if (answer === "mine" && l) propose.push(createOp(c.item, l));
      else apply.push(deleteOp(c.item, c.id));
    }
  }
  const none = { bin: new Set<string>(), clip: new Set<string>() };
  return { propose: order(propose, local, none, local), apply: order(apply, session, none, local) };
}
