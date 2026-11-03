// The reconciler (SPEC §19.5, §20.5): compares, for every entity and field,
// the last agreed value (base), Resolve now (local) and the session (host's
// model), and decides what to propose, what to apply locally, and what to
// ask the user. Pure: callers carry out the plan.
//
// The comparison is the same for every part of the project; a Domain says
// how to read entities and fields and how to build operations. The media
// pool domain is below; timelines have theirs in timeline-reconcile.ts.

import { type Bin, type Clip, type MediaPool, type Op, ROOT, clonePool } from "./media-pool.ts";

export type Mode = "live" | "catch-up";

export interface Conflict {
  key: string;
  kind: "field" | "deleted-here" | "deleted-there";
  item: string; // entity kind, e.g. "clip" or "item"
  id: string;
  label: string; // the entity's name, for the question
  field?: string;
  mine?: unknown;
  theirs?: unknown;
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

// --- media pool (SPEC §19.5) ----------------------------------------------------

export type Kind = "bin" | "clip";

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
  kinds: ["bin", "clip"],
  empty: () => ({ bins: {}, clips: {} }),
  clone: clonePool,
  table: (pool, kind) => (kind === "bin" ? pool.bins : pool.clips),
  skip: (kind, id) => kind === "bin" && id === ROOT,
  fields(kind, entity) {
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
  label: (_kind, entity) => (entity as Bin | Clip).name,
  create: (kind, entity) => (kind === "bin" ? { type: "bin.create", ...(entity as Bin) } : { type: "clip.create", ...structuredClone(entity as Clip) }),
  remove: (kind, id) => ({ type: kind === "bin" ? "bin.delete" : "clip.delete", id }),
  set(kind, id, changes) {
    if (kind === "bin") return { type: "bin.set", id, ...changes } as Op;
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
  // already covers.
  order(ops, created, where, deleted) {
    const rank = (op: Op) => ["bin.create", "bin.set", "clip.create", "clip.set", "clip.delete", "bin.delete"].indexOf(op.type);
    return ops
      .filter((op) => {
        if (op.type === "bin.delete") return !coveredByDelete(where, "bin", op.id, deleted.bin ?? new Set());
        if (op.type === "clip.delete") return !coveredByDelete(where, "clip", op.id, deleted.bin ?? new Set());
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
