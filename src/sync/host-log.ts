// Host-ordered operation log (SPEC §19.3). The host numbers every accepted
// operation and everyone applies them in that order, so all PCs end with the
// same model.

import { type SessionModel, type SessionOp, applySessionOp, cloneModel, emptyModel, validateSessionOp } from "./session-model.ts";

export interface Commit {
  seq: number;
  op: SessionOp;
  author: string; // peer ID of whoever proposed it
  proposal?: string; // the proposer's own ID for it, so they can match it up
}

export interface SessionState {
  seq: number;
  model: SessionModel;
}

export class HostLog {
  seq = 0;
  readonly model: SessionModel;

  constructor(state?: SessionState) {
    this.seq = state?.seq ?? 0;
    this.model = state ? cloneModel(state.model) : emptyModel();
  }

  // Validates, numbers and applies op. Returns the commit to send to everyone,
  // or the reason it was refused.
  propose(op: unknown, author: string, proposal?: string): Commit | { error: string } {
    const error = validateSessionOp(this.model, op);
    if (error) return { error };
    applySessionOp(this.model, op as SessionOp);
    this.seq++;
    return { seq: this.seq, op: op as SessionOp, author, ...(proposal ? { proposal } : {}) };
  }

  state(): SessionState {
    return { seq: this.seq, model: cloneModel(this.model) };
  }
}

// A member's copy of the session: applies commits strictly in order.
export class MemberLog {
  seq = -1; // no state yet
  model: SessionModel = emptyModel();

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
    applySessionOp(this.model, commit.op);
    this.seq = commit.seq;
    return "applied";
  }
}
