// The reconciler (SPEC §19.5, §20.5): compares, for every entity and field,
// the last agreed value (base), Resolve now (local) and the session (host's
// model), and decides what to propose, what to apply locally, and what to
// ask the user. Pure: callers carry out the plan.
//
// The comparison is the same for every part of the project; a Domain says
// how to read entities and fields and how to build operations. The media
// pool domain is below; timelines have theirs in timeline-reconcile.ts.

import { MARKER_FIELDS, markerValues } from "./marker.ts";
import { type Bin, type Clip, type MediaPool, type Op, type PoolMarker, ROOT, clonePool } from "./media-pool.ts";

export type Mode = "live" | "catch-up";

export interface Conflict {
  key: string;
  // "clash": two markers on one frame (SPEC §21.5); `id` is mine.
  kind: "field" | "deleted-here" | "deleted-there" | "clash";
  item: string; // entity kind, e.g. "clip" or "item"
  id: string;
  label: string; // the entity's name, for the question
  field?: string;
  mine?: unknown;
  theirs?: unknown;
  // A clash's operations for each answer: proposed for "mine", applied here for "theirs".
  mineOps?: unknown[];
  theirsOps?: unknown[];
}

export type Answer = "mine" | "theirs";

export interface Input<M> {
  base: M | null; // null on first join: nothing agreed yet
  local: M;
  session: M;
  mode: Mode;
  // Proposals in flight: field key (see fieldKey) → proposed value.
  pending: ReadonlyMap<string, unknown>;
  // Entities with a bridge command in flight ("clip:<id>"); left alone.
  busy: ReadonlySet<string>;
}

export interface PlanOf<M, O> {
  propose: O[];
  apply: O[]; // session values to bring into Resolve
  conflicts: Conflict[]; // need an answer (catch-up, or a delete race)
  overwritten: Conflict[]; // live races the session won; the user is told
  base: M;
}

export type Fields = Record<string, unknown>;
type Entity = object;

export interface Deleted {
  [kind: string]: Set<string>;
}

export interface Domain<M, O> {
  kinds: readonly string[];
  empty(): M;
  clone(model: M): M;
  table(model: M, kind: string): Record<string, Entity>;
  skip?(kind: string, id: string): boolean;
  fields(kind: string, entity: Entity): Fields;
  // Value of a field the entity doesn't have (e.g. an unset meta key).
  missing?(field: string): unknown;
  label(kind: string, entity: Entity): string;
  create(kind: string, entity: Entity): O;
  remove(kind: string, id: string): O;
  set(kind: string, id: string, changes: Fields): O;
  // The entity rebuilt from `entity` with exactly these field values.
  rebuild(kind: string, entity: Entity, fields: Fields): Entity;
  // Dependency order for a batch; `created` is where new entities live,
  // `where` where deleted ones were, `deleted` the ids being deleted.
  order(ops: O[], created: M, where: M, deleted: Deleted): O[];
  // True when a local value differs from base only because Resolve lost it
  // (SPEC §20.5, fades): the session value is put back, nothing is proposed.
  lost?(kind: string, field: string, local: unknown, base: unknown, mode: Mode): boolean;
}

export const itemKey = (item: string, id: string) => `${item}:${id}`;
export const fieldKey = (item: string, id: string, field: string) => `${item}:${id}:${field}`;
// Existence (create/delete) is tracked as the pseudo-field "*".
export const EXISTS = "*";

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function reconcileWith<M, O>(domain: Domain<M, O>, input: Input<M>): PlanOf<M, O> {
  const { local, session, mode, pending, busy } = input;
  const base = input.base ?? domain.empty();
  const firstJoin = input.base === null;
  const plan: PlanOf<M, O> = { propose: [], apply: [], conflicts: [], overwritten: [], base: domain.clone(base) };
  const proposedDeletes: Deleted = {};
  const appliedDeletes: Deleted = {};
  const get = (fields: Fields | undefined, field: string) => {
    const value = fields?.[field];
    return value === undefined ? domain.missing?.(field) : value;
  };

  for (const item of domain.kinds) {
    proposedDeletes[item] = new Set();
    appliedDeletes[item] = new Set();
    const ids = new Set([...Object.keys(domain.table(base, item)), ...Object.keys(domain.table(local, item)), ...Object.keys(domain.table(session, item))]);
    for (const id of ids) {
      if (domain.skip?.(item, id) || busy.has(itemKey(item, id))) continue;
      const b = domain.table(base, item)[id];
      const l = domain.table(local, item)[id];
      const s = domain.table(session, item)[id];
      const baseTable = domain.table(plan.base, item);
      const label = domain.label(item, (l ?? s ?? b)!);
      const existsKey = fieldKey(item, id, EXISTS);
      const fieldsOf = (e: Entity | undefined) => (e ? domain.fields(item, e) : undefined);

      if (!l && !s) {
        delete baseTable[id];
        continue;
      }
      if (l && !s) {
        if (!b) {
          if (!pending.has(existsKey)) plan.propose.push(domain.create(item, l));
        } else if (pending.has(existsKey)) {
          // our own re-create is in flight
        } else if (same(fieldsOf(l), fieldsOf(b))) {
          plan.apply.push(domain.remove(item, id));
          appliedDeletes[item]!.add(id);
        } else {
          plan.conflicts.push({ key: existsKey, kind: "deleted-there", item, id, label });
        }
        continue;
      }
      if (!l && s) {
        if (!b) {
          plan.apply.push(domain.create(item, s));
        } else if (pending.has(existsKey)) {
          // our delete is in flight
        } else if (same(fieldsOf(s), fieldsOf(b))) {
          plan.propose.push(domain.remove(item, id));
          proposedDeletes[item]!.add(id);
        } else {
          plan.conflicts.push({ key: existsKey, kind: "deleted-here", item, id, label });
        }
        continue;
      }

      // On both sides: compare field by field.
      const lf = fieldsOf(l)!;
      const sf = fieldsOf(s)!;
      const bf = fieldsOf(b);
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
        // A field one side doesn't report at all (e.g. transform properties
        // of an audio clip in Resolve) is neither proposed nor applied.
        if (lv === undefined || sv === undefined) {
          agreed[field] = sv ?? lv;
          continue;
        }
        // Nothing agreed yet (first join, or not yet seen on both sides):
        // the session's value wins.
        const bv = bf && !firstJoin ? get(bf, field) : lv;
        if (bf && !firstJoin && domain.lost?.(item, field, lv, bv, mode)) {
          applyChanges[field] = sv;
          agreed[field] = sv;
          continue;
        }
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
      if (Object.keys(proposeChanges).length) plan.propose.push(domain.set(item, id, proposeChanges));
      if (Object.keys(applyChanges).length) plan.apply.push(domain.set(item, id, applyChanges));
      baseTable[id] = domain.rebuild(item, s!, agreed);
    }
  }

  // Proposed deletes are gone locally, so their parents are looked up in base.
  plan.propose = domain.order(plan.propose, local, base, proposedDeletes);
  plan.apply = domain.order(plan.apply, session, local, appliedDeletes);
  return plan;
}

// Turns answers into operations. Unanswered conflicts are left out.
export function resolveWith<M, O>(
  domain: Domain<M, O>,
  conflicts: Conflict[],
  answers: ReadonlyMap<string, Answer>,
  local: M,
  session: M,
): { propose: O[]; apply: O[] } {
  const propose: O[] = [];
  const apply: O[] = [];
  for (const c of conflicts) {
    const answer = answers.get(c.key);
    if (!answer) continue;
    const l = domain.table(local, c.item)[c.id];
    const s = domain.table(session, c.item)[c.id];
    if (c.kind === "clash") {
      // Already in order: what makes room first, then what goes on the frame.
      if (answer === "mine") propose.push(...(c.mineOps as O[]));
      else apply.push(...(c.theirsOps as O[]));
      continue;
    }
    if (c.kind === "field") {
      const changes = { [c.field!]: answer === "mine" ? c.mine : c.theirs };
      (answer === "mine" ? propose : apply).push(domain.set(c.item, c.id, changes));
    } else if (c.kind === "deleted-here") {
      // mine = it stays deleted; theirs = bring their version back here
      if (answer === "mine") propose.push(domain.remove(c.item, c.id));
      else if (s) apply.push(domain.create(c.item, s));
    } else {
      // deleted-there: mine = keep my edited version for everyone
      if (answer === "mine" && l) propose.push(domain.create(c.item, l));
      else apply.push(domain.remove(c.item, c.id));
    }
  }
  const none: Deleted = Object.fromEntries(domain.kinds.map((k) => [k, new Set<string>()]));
  return { propose: domain.order(propose, local, local, none), apply: domain.order(apply, session, local, none) };
}

// What a live race the session won tells the person it overwrote.
export function overwriteMessage(c: Conflict): string {
  if (c.kind === "clash") {
    const m = (v: unknown) => `"${(v as FrameMarker).name}" (${(v as FrameMarker).color})`;
    return `someone put a marker on frame ${(c.theirs as FrameMarker).frame} at the same moment; theirs, ${m(c.theirs)}, replaced yours, ${m(c.mine)}`;
  }
  return `someone changed ${c.field} of "${c.label}" at the same moment; their ${JSON.stringify(c.theirs)} replaced your ${JSON.stringify(c.mine)}`;
}

interface FrameMarker {
  id: string;
  frame: number;
  duration: number;
  color: string;
  name: string;
  note: string;
}

// Two markers on one frame (SPEC §21.5): Resolve holds one per frame per
// owner. A marker this plan would add or move onto a frame where the session
// has another marker on the same owner is a clash, not a proposal: in
// catch-up the user is asked, live the session's marker wins. Changes the
// plan in place. `ownerOf` gives a marker's owner key.
export function frameClashes<M, O extends { type: string; id: string }>(
  domain: Domain<M, O>, kind: string, plan: PlanOf<M, O>, local: M, session: M, mode: Mode, ownerOf: (marker: never) => string,
): void {
  const owner = ownerOf as (marker: FrameMarker) => string;
  const mineTable = domain.table(local, kind) as Record<string, FrameMarker>;
  const sessionTable = domain.table(session, kind) as Record<string, FrameMarker>;
  const handled = new Set<string>(); // their markers dealt with here
  for (const op of [...plan.propose]) {
    const isSet = op.type === `${kind}.set`;
    if (op.type !== `${kind}.create` && !(isSet && (op as unknown as { frame?: number }).frame !== undefined)) continue;
    const mine = mineTable[op.id];
    if (!mine) continue;
    const theirs = Object.values(sessionTable).find((s) => s.id !== mine.id && s.frame === mine.frame && owner(s) === owner(mine));
    if (!theirs) continue;
    handled.add(theirs.id);
    // Whatever the plan brings in for their marker waits for the answer.
    const theirsIn = plan.apply.filter((o) => o.id === theirs.id);
    plan.propose = plan.propose.filter((o) => o !== op);
    plan.apply = plan.apply.filter((o) => o.id !== theirs.id);
    const before = sessionTable[mine.id]; // mine as everyone has it, when it was moved
    const makeRoom = before ? domain.set(kind, mine.id, { frame: before.frame }) : domain.remove(kind, mine.id);
    const values = (m: FrameMarker) => ({ frame: m.frame, duration: m.duration, color: m.color, name: m.name, note: m.note });
    const clash: Conflict = {
      key: fieldKey(kind, mine.id, "frame"), kind: "clash", item: kind, id: mine.id, label: domain.label(kind, mine), field: "frame",
      mine: values(mine), theirs: values(theirs),
      mineOps: [domain.remove(kind, theirs.id), op],
      theirsOps: [makeRoom, ...(theirsIn.length ? theirsIn : [domain.create(kind, theirs)])],
    };
    if (mode === "live") {
      plan.apply.push(...(clash.theirsOps as O[]));
      plan.overwritten.push(clash);
    } else {
      plan.conflicts.push(clash);
    }
  }
  // Their marker coming onto a frame where this PC has one the session
  // doesn't know yet (its proposal, or the answer that replaces theirs, is
  // on its way): it waits, rather than failing in Resolve.
  plan.apply = plan.apply.filter((op) => {
    if (handled.has(op.id) || (op.type !== `${kind}.create` && op.type !== `${kind}.set`)) return true;
    const theirs = sessionTable[op.id];
    if (!theirs) return true;
    return !Object.values(mineTable).some((m) => m.id !== theirs.id && !sessionTable[m.id] && m.frame === theirs.frame && owner(m) === owner(theirs));
  });
}

// --- media pool (SPEC §19.5) ----------------------------------------------------

export type Kind = "bin" | "clip" | "poolmarker";

function depth(pool: MediaPool, id: string): number {
  let n = 0;
  for (let at = pool.bins[id]; at && at.id !== ROOT; at = pool.bins[at.parent]) n++;
  return n;
}

// True if any bin above the entity (in pool) is in the deleted set: the
// cascade already covers it.
function coveredByDelete(pool: MediaPool, item: string, id: string, deletedBins: Set<string>): boolean {
  let at = item === "bin" ? pool.bins[id]?.parent : pool.clips[id]?.bin;
  for (; at; at = pool.bins[at]?.parent) if (deletedBins.has(at)) return true;
  return false;
}

export const mediaPoolDomain: Domain<MediaPool, Op> = {
  kinds: ["bin", "clip", "poolmarker"],
  empty: () => ({ bins: {}, clips: {}, markers: {} }),
  clone: clonePool,
  table: (pool, kind) => (kind === "bin" ? pool.bins : kind === "clip" ? pool.clips : pool.markers),
  skip: (kind, id) => kind === "bin" && id === ROOT,
  fields(kind, entity) {
    // A marker's clip never changes.
    if (kind === "poolmarker") return { ...markerValues(entity as PoolMarker) };
    if (kind === "bin") {
      const bin = entity as Bin;
      return { name: bin.name, parent: bin.parent };
    }
    const clip = entity as Clip;
    const fields: Fields = { name: clip.name, bin: clip.bin, color: clip.color, flags: clip.flags };
    for (const [key, value] of Object.entries(clip.meta)) fields[`meta:${key}`] = value;
    return fields;
  },
  // A missing meta key reads as "" (unset).
  missing: (field) => (field.startsWith("meta:") ? "" : undefined),
  label: (kind, entity) =>
    kind === "poolmarker" ? (entity as PoolMarker).name || `marker at frame ${(entity as PoolMarker).frame}` : (entity as Bin | Clip).name,
  create: (kind, entity) => ({ type: `${kind as Kind}.create`, ...structuredClone(entity) }) as Op,
  remove: (kind, id) => ({ type: `${kind as Kind}.delete`, id }) as Op,
  set(kind, id, changes) {
    if (kind !== "clip") return { type: `${kind as Kind}.set`, id, ...changes } as Op;
    const meta: Record<string, string> = {};
    const rest: Fields = {};
    for (const [field, value] of Object.entries(changes)) {
      if (field.startsWith("meta:")) meta[field.slice(5)] = value as string;
      else rest[field] = value;
    }
    return { type: "clip.set", id, ...rest, ...(Object.keys(meta).length ? { meta } : {}) } as Op;
  },
  rebuild(kind, entity, fields) {
    const out = structuredClone(entity) as Bin | Clip;
    if (kind === "poolmarker") for (const k of MARKER_FIELDS) delete (out as unknown as Fields)[k];
    if (kind === "clip") (out as Clip).meta = {};
    for (const [field, value] of Object.entries(fields)) {
      if (field.startsWith("meta:")) {
        if (value !== "") (out as Clip).meta[field.slice(5)] = value as string;
      } else {
        (out as unknown as Fields)[field] = structuredClone(value);
      }
    }
    return out;
  },
  // Creates parent-first; sets; deletes last, leaving out ones a bin delete
  // already covers. Markers go after their clip is created and before it's
  // deleted; marker deletes and moves first, freeing frames (SPEC §21.1).
  order(ops, created, where, deleted) {
    const rank = (op: Op) => ["bin.create", "bin.set", "clip.create", "clip.set", "poolmarker.delete", "poolmarker.set", "poolmarker.create",
      "clip.delete", "bin.delete"].indexOf(op.type);
    return ops
      .filter((op) => {
        if (op.type === "bin.delete") return !coveredByDelete(where, "bin", op.id, deleted.bin ?? new Set());
        if (op.type === "clip.delete") return !coveredByDelete(where, "clip", op.id, deleted.bin ?? new Set());
        if (op.type === "poolmarker.delete") {
          const clip = where.markers[op.id]?.clip;
          return !clip || !(deleted.clip?.has(clip) || coveredByDelete(where, "clip", clip, deleted.bin ?? new Set()));
        }
        return true;
      })
      .sort((a, b) => rank(a) - rank(b) || (a.type === "bin.create" && b.type === "bin.create" ? depth(created, a.id) - depth(created, b.id) : 0));
  },
};

export type ReconcileInput = Input<MediaPool>;
export type Plan = PlanOf<MediaPool, Op>;

export function reconcile(input: ReconcileInput): Plan {
  return reconcileWith(mediaPoolDomain, input);
}

export function resolveConflicts(conflicts: Conflict[], answers: ReadonlyMap<string, Answer>, local: MediaPool, session: MediaPool): { propose: Op[]; apply: Op[] } {
  return resolveWith(mediaPoolDomain, conflicts, answers, local, session);
}
