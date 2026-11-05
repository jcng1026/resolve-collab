// Host-ordered operation log (SPEC §19.3). The host numbers every accepted
// operation and everyone applies them in that order, so all PCs end with the
// same model.

import { Races } from "./races.ts";
import { type SessionModel, type SessionOp, applySessionOp, cloneModel, emptyModel, validateSessionOp } from "./session-model.ts";

export interface Commit {
  seq: number;
  op: SessionOp;
  author: string; // peer ID of whoever proposed it
  proposal?: string; // the proposer's own ID for it, so they can match it up
  name?: string; // the author's name, for notices (SPEC §23.1)
  lost?: string[]; // properties left out: someone else changed them first
  // "Keep mine" replaced these values set last by others (SPEC §23.3); key as in races.ts.
  replaced?: { author: string; key: string; value: unknown }[];
}

export interface ProposeOptions {
  proposal?: string; // the proposer's own ID for it
  base?: number; // the seq of the state it was made on (SPEC §23.1)
  name?: string; // the author's name, for notices
  keep?: boolean; // a returning person's "Keep mine" (SPEC §23.3)
}

export interface SessionState {
  seq: number;
  model: SessionModel;
}

function tableOf(model: SessionModel, kind: string): Record<string, unknown> | undefined {
  const tables: Record<string, Record<string, unknown>> = {
    bin: model.pool.bins, clip: model.pool.clips, poolmarker: model.pool.markers,
    timeline: model.timelines.timelines, track: model.timelines.tracks, item: model.timelines.items, marker: model.timelines.markers,
  };
  return tables[kind];
}

export class HostLog {
  seq = 0;
  readonly model: SessionModel;
  // Who changed what when, since this companion started (SPEC §23.1).
  private readonly races = new Races();
  // Told about every operation just before it's applied (undo history, §23.2).
  onApply?: (before: SessionModel, op: SessionOp, author: string, proposal?: string) => void;

  constructor(state?: SessionState) {
    this.seq = state?.seq ?? 0;
    this.model = state ? cloneModel(state.model) : emptyModel();
  }

  // Validates, numbers and applies op. Returns the commit to send to everyone,
  // or the reason it was refused. `base` is the seq of the state the change
  // was made on: properties someone else changed after it are left out, and
  // if nothing is left it's refused as "raced" (SPEC §23.1).
  propose(op: unknown, author: string, options: ProposeOptions = {}): Commit | { error: string; lost?: string[] } {
    const { proposal, base, name, keep } = options;
    const error = validateSessionOp(this.model, op);
    if (error) return { error };
    let accepted = op as SessionOp;
    let lost: string[] = [];
    if (base !== undefined && base < this.seq) {
      const race = this.races.check(accepted, author, base);
      if (!race.ok) return { error: "raced", lost: race.lost };
      accepted = race.op;
      lost = race.lost;
    }
    const replaced = keep ? this.replacedBy(accepted, author) : [];
    this.races.record(this.model, accepted, author, this.seq + 1);
    this.onApply?.(this.model, accepted, author, proposal);
    applySessionOp(this.model, accepted);
    this.seq++;
    return { seq: this.seq, op: accepted, author, ...(proposal ? { proposal } : {}), ...(name ? { name } : {}), ...(lost.length ? { lost } : {}), ...(replaced.length ? { replaced } : {}) };
  }

  // The values a change replaces that someone else set last, as they are now.
  private replacedBy(op: SessionOp, author: string): NonNullable<Commit["replaced"]> {
    const kind = op.type.slice(0, op.type.indexOf("."));
    const id = (op as { id: string }).id;
    const entity = tableOf(this.model, kind)?.[id] as Record<string, unknown> | undefined;
    if (!entity) return [];
    const valueOf = (key: string) => {
      const at = key.indexOf(":");
      return at < 0 ? entity[key] : (entity[key.slice(0, at)] as Record<string, unknown> | undefined)?.[key.slice(at + 1)];
    };
    return this.races.lastAuthors(op)
      .filter((r) => r.author !== author)
      .map((r) => ({ author: r.author, key: r.key, value: structuredClone(valueOf(r.key) ?? (r.key.startsWith("meta:") ? "" : null)) }))
      .filter((r) => r.value !== null);
  }

  state(): SessionState {
    return { seq: this.seq, model: cloneModel(this.model) };
  }
}

// A member's copy of the session: applies commits strictly in order.
export class MemberLog {
  seq = -1; // no state yet
  model: SessionModel = emptyModel();
  // Told about every commit just before it's applied (undo history, §23.2).
  onApply?: (before: SessionModel, op: SessionOp, author: string, proposal?: string) => void;

  get ready(): boolean {
    return this.seq >= 0;
  }

  reset(state: SessionState): void {
    this.seq = state.seq;
    this.model = cloneModel(state.model);
  }

  // "applied", "old" (already have it), or "gap" (ask the host for its state).
  receive(commit: Commit): "applied" | "old" | "gap" {
    if (!this.ready || commit.seq > this.seq + 1) return "gap";
    if (commit.seq <= this.seq) return "old";
    // The host already validated it; a failure here means our copy drifted.
    if (validateSessionOp(this.model, commit.op)) return "gap";
    this.onApply?.(this.model, commit.op, commit.author, commit.proposal);
    applySessionOp(this.model, commit.op);
    this.seq = commit.seq;
    return "applied";
  }
}
