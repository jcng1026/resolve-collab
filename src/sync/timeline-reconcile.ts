// The reconciler's timeline domain (SPEC §20.5): how timelines, tracks and
// items are compared field by field, how operations are built, and the order
// a batch is applied in.

import { type Conflict, type Deleted, type Domain, type Fields, type Input, type PlanOf, reconcileWith } from "./reconcile.ts";
import { MARKER_FIELDS, markerValues } from "./marker.ts";
import { type Item, type Marker, type TimelineInfo, type TimelineOp, type Timelines, type Track, emptyTimelines } from "./timeline.ts";

type Kind = "timeline" | "track" | "item" | "marker";

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

// Markers come after the items they sit on are created and before those are
// deleted. Marker deletes and moves go first: they free frames other markers
// may move onto (one marker per frame, SPEC §21.1).
const RANK = ["timeline.create", "track.create", "marker.delete", "item.delete", "item.set", "item.create", "transition.create",
  "marker.set", "marker.create", "track.set", "track.delete", "timeline.set", "timeline.delete"];

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
  if (op.type === "marker.delete") {
    const marker = where.markers[op.id];
    if (!marker) return false;
    if (deleted.timeline?.has(marker.timeline)) return true;
    const item = marker.item ? where.items[marker.item] : undefined;
    return item !== undefined && ((deleted.item?.has(item.id) ?? false) || (deleted.track?.has(item.track) ?? false));
  }
  return false;
}

export const timelineDomain: Domain<Timelines, TimelineOp> = {
  kinds: ["timeline", "track", "item", "marker"],
  empty: emptyTimelines,
  clone: (m) => structuredClone(m),
  table: (m, kind) => (kind === "timeline" ? m.timelines : kind === "track" ? m.tracks : kind === "item" ? m.items : m.markers),
  fields(kind, entity) {
    // A marker's owner never changes (Resolve can't move one between owners).
    if (kind === "marker") return { ...markerValues(entity as Marker) };
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
    if (kind === "marker") {
      const m = entity as Marker;
      return m.name || `marker at frame ${m.frame}`;
    }
    return (entity as TimelineInfo | Item).name;
  },
  create: (kind, entity) => ({ type: `${kind as Kind}.create`, ...structuredClone(entity) }) as TimelineOp,
  remove: (kind, id) => ({ type: `${kind as Kind}.delete`, id }) as TimelineOp,
  set: setOp,
  rebuild(kind, entity, fields) {
    const out = structuredClone(entity) as Record<string, unknown>;
    if (kind === "marker") for (const k of MARKER_FIELDS) delete out[k];
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

// A linked video and audio pair that conflicts the same way is one question
// (SPEC §9.3): each group's first conflict is asked, and its answer stands for
// the rest of the group.
export function groupLinked(conflicts: Conflict[], ...models: Timelines[]): Conflict[][] {
  const linkOf = (id: string) => models.map((m) => m.items[id]?.link).find((l) => l) ?? "";
  const groups = new Map<string, Conflict[]>();
  for (const c of conflicts) {
    const link = c.item === "item" ? linkOf(c.id) : "";
    const key = link ? JSON.stringify([link, c.kind, c.field ?? "", c.mine ?? null, c.theirs ?? null]) : c.key;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()];
}
