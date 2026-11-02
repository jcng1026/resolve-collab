import { describe, expect, it } from "vitest";
import { HostLog, MemberLog } from "./host-log.ts";
import { type Clip, type MediaPool, type Op, ROOT, applyOp, binPath, clonePool, emptyPool, validateOp } from "./media-pool.ts";
import { type ReconcileInput, fieldKey, reconcile, resolveConflicts } from "./reconcile.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const HASH = "a".repeat(64);

function clip(n: number, extra: Partial<Clip> = {}): Clip {
  return { id: id(n), name: `clip${n}.mp4`, bin: ROOT, color: "", flags: [], meta: {}, file: { name: `clip${n}.mp4`, size: 100, hash: HASH }, ...extra };
}

// Root, bin 1 ("Footage") holding clip 10, and clip 11 in the root.
function pool(): MediaPool {
  const p = emptyPool();
  p.bins[id(1)] = { id: id(1), name: "Footage", parent: ROOT };
  p.clips[id(10)] = clip(10, { bin: id(1) });
  p.clips[id(11)] = clip(11);
  return p;
}

function run(changes: Partial<ReconcileInput> & { local: MediaPool; session: MediaPool }) {
  return reconcile({ base: pool(), mode: "live", pending: new Map(), busy: new Set(), ...changes });
}

function edit(p: MediaPool, fn: (p: MediaPool) => void): MediaPool {
  const copy = clonePool(p);
  fn(copy);
  return copy;
}

describe("media pool operations", () => {
  it("refuses malformed or impossible operations", () => {
    const p = pool();
    expect(validateOp(p, { type: "bin.create", id: "x", name: "A", parent: ROOT })).toMatch(/id/);
    expect(validateOp(p, { type: "bin.create", id: id(2), name: "A", parent: id(99) })).toMatch(/parent/);
    expect(validateOp(p, { type: "bin.create", id: id(2), name: "", parent: ROOT })).toMatch(/name/);
    expect(validateOp(p, { type: "bin.set", id: id(1), parent: id(1) })).toMatch(/itself/);
    expect(validateOp(p, { type: "clip.set", id: id(10), meta: { Scene: 5 } })).toMatch(/meta/);
    expect(validateOp(p, { ...clip(12), type: "clip.create", file: { name: "a", size: -1, hash: HASH } })).toMatch(/file/);
    expect(validateOp(p, { ...clip(12), type: "clip.create", meta: { Scene: "" } })).toMatch(/empty/);
    expect(validateOp(p, { type: "launch.missiles" })).toMatch(/unknown/);
    expect(validateOp(p, null)).toMatch(/object/);
    expect(validateOp(p, { type: "clip.delete", id: id(77) })).toBeNull(); // already gone is fine
  });

  it("cascades bin deletes, unsets empty meta, and is idempotent", () => {
    const p = pool();
    p.bins[id(2)] = { id: id(2), name: "Day 1", parent: id(1) };
    p.clips[id(12)] = clip(12, { bin: id(2) });
    expect(binPath(p, id(2))).toBe("/Footage/Day 1/");
    applyOp(p, { type: "bin.delete", id: id(1) });
    expect(Object.keys(p.bins)).toEqual([ROOT]);
    expect(Object.keys(p.clips)).toEqual([id(11)]);

    const set: Op = { type: "clip.set", id: id(11), meta: { Scene: "4", Take: "" }, flags: ["Red", "Blue"] };
    applyOp(p, set);
    const once = clonePool(p);
    applyOp(p, set);
    expect(p).toEqual(once);
    expect(p.clips[id(11)]!.meta).toEqual({ Scene: "4" });
    expect(p.clips[id(11)]!.flags).toEqual(["Blue", "Red"]);
  });
});

describe("host-ordered log", () => {
  it("numbers accepted operations and refuses invalid ones", () => {
    const host = new HostLog();
    const ok = host.propose({ type: "bin.create", id: id(1), name: "A", parent: ROOT }, "peer1", "p1");
    expect(ok).toMatchObject({ seq: 1, author: "peer1", proposal: "p1" });
    expect(host.propose({ type: "bin.create", id: id(1), name: "A", parent: ROOT }, "peer1")).toHaveProperty("error");
    expect(host.seq).toBe(1);
  });

  it("members apply commits in order and ask for state on a gap", () => {
    const host = new HostLog();
    const c1 = host.propose({ type: "bin.create", id: id(1), name: "A", parent: ROOT }, "h") as never;
    const c2 = host.propose({ type: "bin.set", id: id(1), name: "B" }, "h") as never;
    const member = new MemberLog();
    expect(member.receive(c1)).toBe("gap"); // no state yet
    member.reset({ seq: 0, model: emptyPool() });
    expect(member.receive(c2)).toBe("gap");
    expect(member.receive(c1)).toBe("applied");
    expect(member.receive(c1)).toBe("old");
    expect(member.receive(c2)).toBe("applied");
    expect(member.model).toEqual(host.model);
  });
});

describe("reconciler", () => {
  it("does nothing when nothing changed", () => {
    const plan = run({ local: pool(), session: pool() });
    expect(plan).toMatchObject({ propose: [], apply: [], conflicts: [], overwritten: [] });
    expect(plan.base).toEqual(pool());
  });

  it("proposes local edits and applies session edits", () => {
    const local = edit(pool(), (p) => { p.clips[id(10)]!.name = "mine.mp4"; });
    const session = edit(pool(), (p) => { p.bins[id(1)]!.name = "Renamed"; });
    const plan = run({ local, session });
    expect(plan.propose).toEqual([{ type: "clip.set", id: id(10), name: "mine.mp4" }]);
    expect(plan.apply).toEqual([{ type: "bin.set", id: id(1), name: "Renamed" }]);
    // Neither is agreed yet, so base keeps the old values.
    expect(plan.base.clips[id(10)]!.name).toBe("clip10.mp4");
  });

  it("merges different fields of the same clip, including single meta keys", () => {
    const local = edit(pool(), (p) => { p.clips[id(10)]!.meta = { Scene: "1" }; p.clips[id(10)]!.color = "Orange"; });
    const session = edit(pool(), (p) => { p.clips[id(10)]!.meta = { Take: "2" }; p.clips[id(10)]!.bin = ROOT; });
    const plan = run({ local, session, mode: "catch-up" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.propose).toEqual([{ type: "clip.set", id: id(10), color: "Orange", meta: { Scene: "1" } }]);
    expect(plan.apply).toEqual([{ type: "clip.set", id: id(10), bin: ROOT, meta: { Take: "2" } }]);
  });

  it("updates base when both sides made the same change", () => {
    const changed = edit(pool(), (p) => { p.clips[id(11)]!.color = "Teal"; });
    const plan = run({ local: changed, session: changed });
    expect(plan.propose).toEqual([]);
    expect(plan.apply).toEqual([]);
    expect(plan.base.clips[id(11)]!.color).toBe("Teal");
  });

  describe("same field changed on both sides", () => {
    const local = edit(pool(), (p) => { p.clips[id(11)]!.name = "mine"; });
    const session = edit(pool(), (p) => { p.clips[id(11)]!.name = "theirs"; });

    it("asks in catch-up", () => {
      const plan = run({ local, session, mode: "catch-up" });
      expect(plan.conflicts).toEqual([expect.objectContaining({ kind: "field", field: "name", mine: "mine", theirs: "theirs", label: "mine" })]);
      expect(plan.apply).toEqual([]);
      const { propose, apply } = resolveConflicts(plan.conflicts, new Map([[plan.conflicts[0]!.key, "mine"]]), local, session);
      expect(propose).toEqual([{ type: "clip.set", id: id(11), name: "mine" }]);
      expect(apply).toEqual([]);
    });

    it("lets the session win live, with a notice", () => {
      const plan = run({ local, session });
      expect(plan.apply).toEqual([{ type: "clip.set", id: id(11), name: "theirs" }]);
      expect(plan.overwritten).toHaveLength(1);
    });

    it("waits while our own proposal for it is in flight", () => {
      const plan = run({ local, session, pending: new Map([[fieldKey("clip", id(11), "name"), "mine"]]) });
      expect(plan).toMatchObject({ propose: [], apply: [], conflicts: [], overwritten: [] });
    });
  });

  it("doesn't propose the same value twice, and leaves busy items alone", () => {
    const local = edit(pool(), (p) => { p.clips[id(11)]!.name = "mine"; });
    expect(run({ local, session: pool(), pending: new Map([[fieldKey("clip", id(11), "name"), "mine"]]) }).propose).toEqual([]);
    expect(run({ local, session: pool(), busy: new Set([`clip:${id(11)}`]) }).propose).toEqual([]);
  });

  it("proposes local creates parent-first and applies session creates", () => {
    const local = edit(pool(), (p) => {
      p.bins[id(3)] = { id: id(3), name: "Inner", parent: id(2) };
      p.bins[id(2)] = { id: id(2), name: "Outer", parent: ROOT };
      p.clips[id(12)] = clip(12, { bin: id(3) });
    });
    const session = edit(pool(), (p) => { p.clips[id(13)] = clip(13); });
    const plan = run({ local, session });
    expect(plan.propose.map((op) => `${op.type} ${op.id}`)).toEqual([`bin.create ${id(2)}`, `bin.create ${id(3)}`, `clip.create ${id(12)}`]);
    expect(plan.apply).toEqual([{ type: "clip.create", ...clip(13) }]);
    expect(plan.base.clips[id(12)]).toBeUndefined(); // not agreed until committed
  });

  it("proposes a local bin delete once, covering what was inside", () => {
    const local = edit(pool(), (p) => { delete p.bins[id(1)]; delete p.clips[id(10)]; });
    const plan = run({ local, session: pool() });
    expect(plan.propose).toEqual([{ type: "bin.delete", id: id(1) }]);
  });

  it("applies a session delete when nothing changed here", () => {
    const session = edit(pool(), (p) => { delete p.clips[id(11)]; });
    expect(run({ local: pool(), session }).apply).toEqual([{ type: "clip.delete", id: id(11) }]);
  });

  it("always asks when a delete meets an edit", () => {
    const editedHere = edit(pool(), (p) => { p.clips[id(11)]!.color = "Red"; });
    const deleted = edit(pool(), (p) => { delete p.clips[id(11)]; });
    const there = run({ local: editedHere, session: deleted });
    expect(there.conflicts).toEqual([expect.objectContaining({ kind: "deleted-there", id: id(11) })]);
    expect(resolveConflicts(there.conflicts, new Map([[there.conflicts[0]!.key, "mine"]]), editedHere, deleted).propose)
      .toEqual([{ type: "clip.create", ...clip(11, { color: "Red" }) }]);

    const here = run({ local: deleted, session: editedHere });
    expect(here.conflicts).toEqual([expect.objectContaining({ kind: "deleted-here", id: id(11) })]);
    expect(resolveConflicts(here.conflicts, new Map([[here.conflicts[0]!.key, "theirs"]]), deleted, editedHere).apply)
      .toEqual([{ type: "clip.create", ...clip(11, { color: "Red" }) }]);
  });

  it("on first join, takes the session's values for matched items and combines the rest", () => {
    const local = edit(pool(), (p) => { p.clips[id(11)]!.color = "Red"; p.clips[id(14)] = clip(14); delete p.clips[id(10)]; });
    const plan = reconcile({ base: null, local, session: pool(), mode: "catch-up", pending: new Map(), busy: new Set() });
    expect(plan.conflicts).toEqual([]);
    expect(plan.apply).toEqual([{ type: "clip.create", ...clip(10, { bin: id(1) }) }, { type: "clip.set", id: id(11), color: "" }]);
    expect(plan.propose).toEqual([{ type: "clip.create", ...clip(14) }]);
  });
});
