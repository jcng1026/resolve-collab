// Host-ordered operation log (SPEC §19.3). The host numbers every accepted
// operation and everyone applies them in that order, so all PCs end with the
// same model.

import { type MediaPool, type Op, applyOp, clonePool, emptyPool, validateOp } from "./media-pool.ts";

export interface Commit {
  seq: number;
  op: Op;
  author: string; // peer ID of whoever proposed it
  proposal?: string; // the proposer's own ID for it, so they can match it up
}

export interface SessionState {
  seq: number;
  model: MediaPool;
}

export class HostLog {
  seq = 0;
  readonly model: MediaPool;

  constructor(state?: SessionState) {
    this.seq = state?.seq ?? 0;
    this.model = state ? clonePool(state.model) : emptyPool();
  }

  // Validates, numbers and applies op. Returns the commit to send to everyone,
  // or the reason it was refused.
  propose(op: unknown, author: string, proposal?: string): Commit | { error: string } {
    const error = validateOp(this.model, op);
    if (error) return { error };
    applyOp(this.model, op as Op);
    this.seq++;
    return { seq: this.seq, op: op as Op, author, ...(proposal ? { proposal } : {}) };
  }

  state(): SessionState {
    return { seq: this.seq, model: clonePool(this.model) };
  }
}

// A member's copy of the session: applies commits strictly in order.
export class MemberLog {
  seq = -1; // no state yet
  model: MediaPool = emptyPool();

  get ready(): boolean {
    return this.seq >= 0;
  }

  reset(state: SessionState): void {
    this.seq = state.seq;
    this.model = clonePool(state.model);
  }

  // "applied", "old" (already have it), or "gap" (ask the host for its state).
  receive(commit: Commit): "applied" | "old" | "gap" {
    if (!this.ready || commit.seq > this.seq + 1) return "gap";
    if (commit.seq <= this.seq) return "old";
    // The host already validated it; a failure here means our copy drifted.
    if (validateOp(this.model, commit.op)) return "gap";
    applyOp(this.model, commit.op);
    this.seq = commit.seq;
    return "applied";
  }
}
