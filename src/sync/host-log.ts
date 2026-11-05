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
}

export interface SessionState {
  seq: number;
  model: SessionModel;
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
  propose(op: unknown, author: string, proposal?: string, base?: number, name?: string): Commit | { error: string; lost?: string[] } {
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
    this.races.record(this.model, accepted, author, this.seq + 1);
    this.onApply?.(this.model, accepted, author, proposal);
    applySessionOp(this.model, accepted);
    this.seq++;
    return { seq: this.seq, op: accepted, author, ...(proposal ? { proposal } : {}), ...(name ? { name } : {}), ...(lost.length ? { lost } : {}) };
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
