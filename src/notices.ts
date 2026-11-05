// Notices in the companion's terminal, numbered so a command can act on one
// (SPEC §23.1, §23.3): "reapply <n>" after a lost race, "restore <n>" after
// someone's Keep mine. They move to buttons in the companion window in M8.

import type { Conflict } from "./sync/reconcile.ts";

export interface Notice {
  n: number;
  kind: "reapply" | "restore";
  text: string; // for the terminal, with its number and command
  plain: string; // for the window: the same without them
  // What acting on it proposes: domain-level changes, or ready operations.
  changes: { item: string; id: string; fields: Record<string, unknown> }[];
  ops: unknown[];
}

const FIELD_NAMES: Record<string, string> = {
  color: "colour", name: "name", bin: "bin", flags: "flags", start: "position", duration: "length", track: "track",
  enabled: "on/off", srcStart: "source start", speed: "speed", fadeIn: "fade in", fadeOut: "fade out", frame: "frame",
  note: "note", order: "order", locked: "lock", parent: "bin", text: "text", fps: "frame rate", width: "width", height: "height",
};

export function fieldName(field: string): string {
  if (field.startsWith("meta:")) return field.slice(5);
  if (field.startsWith("prop:")) return field.slice(5);
  return FIELD_NAMES[field] ?? field;
}

// "the colour of "a.mp4"", or for a marker clash "the marker on frame 12".
export function whatChanged(c: Conflict): string {
  if (c.kind === "clash") return `the marker on frame ${(c.theirs as { frame: number }).frame}`;
  return `the ${fieldName(c.field ?? "")} of "${c.label}"`;
}

function list(things: string[]): string {
  if (things.length <= 1) return things[0] ?? "";
  if (things.length <= 3) return `${things.slice(0, -1).join(", ")} and ${things.at(-1)}`;
  return `${things.slice(0, 2).join(", ")} and ${things.length - 2} more`;
}

export class Notices {
  private next = 1;
  private readonly open = new Map<number, Notice>();

  // A lost race: what was undone, and who got there first (SPEC §23.1).
  // `authors` names the latest author of each conflict; one notice per pass.
  raced(conflicts: Conflict[], authorOf: (c: Conflict) => string | undefined): Notice | undefined {
    if (!conflicts.length) return undefined;
    const names = [...new Set(conflicts.map((c) => authorOf(c) ?? "someone"))];
    const who = names.length === 1 ? names[0]! : "Others";
    const things = [...new Set(conflicts.map(whatChanged))];
    const n = this.next++;
    const yours = conflicts.length === 1 ? "your change was" : "your changes were";
    const notice: Notice = {
      n, kind: "reapply",
      text: `[${n}] ${who} changed ${list(things)} at the same moment, so ${yours} undone.  reapply ${n} = send yours again`,
      plain: `${who} changed ${list(things)} at the same moment, so ${yours} undone.`,
      changes: conflicts.filter((c) => c.kind === "field").map((c) => ({ item: c.item, id: c.id, fields: { [c.field!]: c.mine } })),
      ops: conflicts.filter((c) => c.kind === "clash").flatMap((c) => c.mineOps ?? []),
    };
    this.open.set(n, notice);
    return notice;
  }

  // Someone's "Keep mine" replaced this PC's values (SPEC §23.3).
  replaced(name: string, items: { what: string; op: unknown }[]): Notice | undefined {
    if (!items.length) return undefined;
    const n = this.next++;
    const notice: Notice = {
      n, kind: "restore",
      text: `[${n}] ${name}'s offline changes replaced your ${list(items.map((i) => i.what))}.  restore ${n} = put yours back`,
      plain: `${name}'s offline changes replaced your ${list(items.map((i) => i.what))}.`,
      changes: [],
      ops: items.map((i) => i.op),
    };
    this.open.set(n, notice);
    return notice;
  }

  // The notices still waiting, oldest first.
  list(): Notice[] {
    return [...this.open.values()];
  }

  // Takes a notice to act on it (once).
  take(n: number, kind: Notice["kind"]): Notice | undefined {
    const notice = this.open.get(n);
    if (!notice || notice.kind !== kind) return undefined;
    this.open.delete(n);
    return notice;
  }
}
