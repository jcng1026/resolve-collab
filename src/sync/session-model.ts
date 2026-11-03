// The whole session model the host orders changes to: the media pool
// (SPEC §19.2) and the timelines (SPEC §20.2). Operations are routed to their
// part by type.

import { type MediaPool, type Op, applyOp, clonePool, emptyPool, validateOp, validatePool } from "./media-pool.ts";
import { type TimelineOp, type Timelines, applyTimelineOp, emptyTimelines, validateTimelineOp, validateTimelines } from "./timeline.ts";

export interface SessionModel {
  pool: MediaPool;
  timelines: Timelines;
}

export type SessionOp = Op | TimelineOp;

export function emptyModel(): SessionModel {
  return { pool: emptyPool(), timelines: emptyTimelines() };
}

export function cloneModel(model: SessionModel): SessionModel {
  return { pool: clonePool(model.pool), timelines: structuredClone(model.timelines) };
}

// Timeline and item markers are part of the timelines; pool clip markers
// ("poolmarker.*") of the media pool.
const isTimelineOp = (type: unknown) => typeof type === "string" && /^(timeline|track|item|marker)\./.test(type);

export function validateSessionOp(model: SessionModel, op: unknown): string | null {
  if (typeof op !== "object" || op === null) return "not an object";
  const type = (op as { type?: unknown }).type;
  return isTimelineOp(type) ? validateTimelineOp(model.timelines, model.pool, op) : validateOp(model.pool, op);
}

export function applySessionOp(model: SessionModel, op: SessionOp): void {
  if (isTimelineOp(op.type)) applyTimelineOp(model.timelines, op as TimelineOp);
  else applyOp(model.pool, op as Op);
}

// A whole model from a peer or from disk, checked part by part. Accepts the
// M3 format, which was the media pool alone.
export function validateModel(input: unknown): SessionModel | null {
  const raw = input as Partial<SessionModel> & Partial<MediaPool>;
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.bins !== undefined) {
    const pool = validatePool(raw);
    return pool && { pool, timelines: emptyTimelines() };
  }
  const pool = validatePool(raw.pool);
  const timelines = pool && validateTimelines(raw.timelines ?? emptyTimelines(), pool);
  return pool && timelines ? { pool, timelines } : null;
}
