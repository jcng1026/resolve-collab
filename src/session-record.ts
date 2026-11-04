// What this PC remembers about each session it hosts or has joined (SPEC
// §22): `sessions/<session ID>/session.json`, next to that session's sync
// state. The invite code isn't kept: a new one is made every time the host
// opens the session, and the session ID (never shared in the code) says
// which session it is.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Member {
  key: string; // public key (64 hex)
  name: string;
}

export interface SessionRecord {
  id: string;
  role: "host" | "member";
  project: string; // local Resolve project ID; "" until known
  projectName: string;
  hostKey: string;
  hostName: string;
  members: Member[]; // host: PCs let in
  blocked: Member[]; // host: PCs refused from now on
  ended: boolean; // ended for good, or this PC was removed
  updated: number; // ms since epoch
}

export const isSessionId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
export const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export function newRecord(id: string, role: SessionRecord["role"], hostKey: string, hostName: string): SessionRecord {
  return { id, role, project: "", projectName: "", hostKey, hostName, members: [], blocked: [], ended: false, updated: Date.now() };
}

export function sessionDir(root: string, id: string): string {
  if (!isSessionId(id)) throw new Error(`bad session ID: ${id}`);
  return join(root, id);
}

const recordFile = (root: string, id: string) => join(sessionDir(root, id), "session.json");

function valid(raw: unknown): raw is SessionRecord {
  const r = raw as SessionRecord;
  const members = (list: unknown) => Array.isArray(list) && list.every((m) => isKey((m as Member)?.key) && typeof (m as Member).name === "string");
  return typeof r === "object" && r !== null && isSessionId(r.id) && (r.role === "host" || r.role === "member") && typeof r.project === "string"
    && typeof r.projectName === "string" && isKey(r.hostKey) && typeof r.hostName === "string" && members(r.members) && members(r.blocked)
    && typeof r.ended === "boolean" && typeof r.updated === "number";
}

export function loadRecord(root: string, id: string): SessionRecord | undefined {
  const file = recordFile(root, id);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return valid(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function saveRecord(root: string, record: SessionRecord): void {
  const file = recordFile(root, record.id);
  mkdirSync(sessionDir(root, record.id), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function listRecords(root: string): SessionRecord[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(isSessionId).map((id) => loadRecord(root, id)).filter((r): r is SessionRecord => r !== undefined);
}

// The session this PC hosts from an open project (`host --resume`): the
// latest one not ended.
export function findHostSession(root: string, project: string): SessionRecord | undefined {
  return listRecords(root).filter((r) => r.role === "host" && !r.ended && r.project === project).sort((a, b) => b.updated - a.updated)[0];
}
