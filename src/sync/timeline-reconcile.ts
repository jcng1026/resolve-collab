// The reconciler's timeline domain (SPEC §20.5): how timelines, tracks and
// items are compared field by field, how operations are built, and the order
// a batch is applied in.

import { type Deleted, type Domain, type Fields, type Input, type PlanOf, reconcileWith } from "./reconcile.ts";
import { type Item, type TimelineInfo, type TimelineOp, type Timelines, type Track, emptyTimelines } from "./timeline.ts";

type Kind = "timeline" | "track" | "item";

const ITEM_FIELDS = ["track", "start", "duration", "enabled", "color", "name", "media", "srcStart", "link", "speed", "fadeIn", "fadeOut", "template", "text", "edge"] as const;

function itemFields(item: Item): Fields {
  const fields: Fields = {};
  for (const k of ITEM_FIELDS) if (item[k] !== undefined) fields[k] = item[k];
  for (const [k, v] of Object.entries(item.props ?? {})) fields[`prop:${k}`] = v;
  return fields;
}

function setOp(kind: string, id: string, changes: Fields): TimelineOp {
  if (kind !== "item") return { type: `${kind as Kind}.set`, id, ...changes } as TimelineOp;
  const props: Record<string, number | boolean> = {};
  const rest: Fields = {};
  for (const [field, value] of Object.entries(changes)) {
    if (field.startsWith("prop:")) {
      // A property Resolve doesn't report can't be unset; leave it out.
      if (value !== undefined) props[field.slice(5)] = value as number | boolean;
    }
    else rest[field] = value;
  }
  return { type: "item.set", id, ...rest, ...(Object.keys(props).length ? { props } : {}) } as TimelineOp;
}

const RANK = ["timeline.create", "track.create", "item.delete", "item.set", "item.create", "transition.create", "track.set", "track.delete", "timeline.set", "timeline.delete"];

function rank(op: TimelineOp): number {
  if (op.type === "item.create" && op.kind === "transition") return RANK.indexOf("transition.create");
  return RANK.indexOf(op.type);
}

// A move onto occupied space overwrites in Resolve (SPEC §20.1), so items
// moving right go rightmost first and items moving left leftmost first: a
// ripple then never lands on a neighbour that hasn't moved yet.
function moveOrder(a: TimelineOp, b: TimelineOp, where: Timelines): number {
  if (a.type !== "item.set" || b.type !== "item.set" || a.start === undefined || b.start === undefined) return 0;
  const fromA = where.items[a.id]?.start;
  const fromB = where.items[b.id]?.start;
  if (fromA === undefined || fromB === undefined) return 0;
  const rightA = a.start > fromA;
  const rightB = b.start > fromB;
  if (rightA !== rightB) return rightA ? -1 : 1;
  return rightA ? fromB - fromA : fromA - fromB;
}

// True if a delete is already covered by the delete of what holds it.
function covered(op: TimelineOp, where: Timelines, deleted: Deleted): boolean {
  if (op.type === "item.delete") {
    const item = where.items[op.id];
    if (!item) return false;
    if (deleted.track?.has(item.track) || deleted.timeline?.has(item.timeline)) return true;
    return item.edge !== undefined && (deleted.item?.has(item.edge.item) ?? false);
  }
  if (op.type === "track.delete") {
    const track = where.tracks[op.id];
    return track !== undefined && (deleted.timeline?.has(track.timeline) ?? false);
  }
  return false;
}

export const timelineDomain: Domain<Timelines, TimelineOp> = {
  kinds: ["timeline", "track", "item"],
  empty: emptyTimelines,
  clone: (m) => structuredClone(m),
  table: (m, kind) => (kind === "timeline" ? m.timelines : kind === "track" ? m.tracks : m.items),
  fields(kind, entity) {
    if (kind === "timeline") {
      const t = entity as TimelineInfo;
      return { name: t.name, fps: t.fps, width: t.width, height: t.height };
    }
    if (kind === "track") {
      const t = entity as Track;
      return { order: t.order, name: t.name, enabled: t.enabled, locked: t.locked };
    }
    return itemFields(entity as Item);
  },
  label(kind, entity) {
    if (kind === "track") {
      const t = entity as Track;
      return t.name || `${t.kind === "video" ? "V" : "A"}${t.order}`;
    }
    return (entity as TimelineInfo | Item).name;
  },
  create: (kind, entity) => ({ type: `${kind as Kind}.create`, ...structuredClone(entity) }) as TimelineOp,
  remove: (kind, id) => ({ type: `${kind as Kind}.delete`, id }) as TimelineOp,
  set: setOp,
  rebuild(kind, entity, fields) {
    const out = structuredClone(entity) as Record<string, unknown>;
    if (kind === "item") {
      for (const k of ITEM_FIELDS) delete out[k];
      out.props = {};
    }
    for (const [field, value] of Object.entries(fields)) {
      if (field.startsWith("prop:")) (out.props as Record<string, unknown>)[field.slice(5)] = value;
      else out[field] = structuredClone(value);
    }
    if (kind === "item" && Object.keys(out.props as object).length === 0 && !(entity as Item).props) delete out.props;
    return out;
  },
  order(ops, _created, where, deleted) {
    return ops.filter((op) => !covered(op, where, deleted)).sort((a, b) => rank(a) - rank(b) || moveOrder(a, b, where));
  },
  // Resolve forgets fades set through the API when the project is reopened
  // (SPEC §20.5): in catch-up a lost fade is put back, not proposed.
  lost: (kind, field, local, base, mode) =>
    mode === "catch-up" && kind === "item" && (field === "fadeIn" || field === "fadeOut") && local === 0 && typeof base === "number" && base > 0,
};

export type TimelinePlan = PlanOf<Timelines, TimelineOp>;

export function reconcileTimelines(input: Input<Timelines>): TimelinePlan {
  return reconcileWith(timelineDomain, input);
}
