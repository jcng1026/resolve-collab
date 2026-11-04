// This PC's lasting identity (SPEC §22.1): a random seed from which the peer
// link derives the same key pair every run, so the host can recognise (and
// block) a PC from one day to the next; and the person's name, asked once.
// Kept in identity.json under the ResolveCollab folder; the seed is secret.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  seed: Buffer; // 32 bytes
  name: string | undefined;
}

const MAX_NAME = 40;

export function validName(name: string): boolean {
  return name.trim().length > 0 && name.length <= MAX_NAME && !/[\u0000-\u001f]/.test(name);
}

function file(dir: string): string {
  return join(dir, "identity.json");
}

function save(dir: string, identity: Identity): void {
  mkdirSync(dir, { recursive: true });
  const data = { seed: identity.seed.toString("hex"), ...(identity.name ? { name: identity.name } : {}) };
  writeFileSync(`${file(dir)}.tmp`, JSON.stringify(data));
  renameSync(`${file(dir)}.tmp`, file(dir));
}

export function loadIdentity(dir: string): Identity {
  if (existsSync(file(dir))) {
    const raw = JSON.parse(readFileSync(file(dir), "utf8")) as { seed?: unknown; name?: unknown };
    if (typeof raw.seed !== "string" || !/^[0-9a-f]{64}$/.test(raw.seed)) throw new Error(`damaged ${file(dir)}: delete it to make a new identity`);
    return { seed: Buffer.from(raw.seed, "hex"), name: typeof raw.name === "string" && validName(raw.name) ? raw.name : undefined };
  }
  const identity: Identity = { seed: randomBytes(32), name: undefined };
  save(dir, identity);
  return identity;
}

export function saveName(dir: string, name: string): void {
  if (!validName(name)) throw new Error(`a name is 1 to ${MAX_NAME} characters`);
  save(dir, { ...loadIdentity(dir), name: name.trim() });
}
