// Wire format between the companion and the Lua bridge (SPEC §18.1).
//
// Bridge → companion: errors raised through fusion:Execute land in
// ResolveDebug.txt as `... RC|<bridgeId>|<kind>|<hex(JSON)>`. Log lines are
// cut at ~2000 characters, so a long message is sent as several lines, each
// ending `|<part>/<parts>/<msgId>` (SPEC §19.4).
// Companion → bridge: subfolders of an inbox folder named
// `<seq:8>.<part:3>.<parts:3>.<hex(JSON chunk)>`, listed by the bridge with
// MediaStorage:GetSubFolderList.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const OUTBOUND_KINDS = ["HELLO", "HB", "ACK", "EVT", "RES", "ERR"] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export interface OutboundLine {
  bridgeId: string;
  kind: OutboundKind;
  payload: JsonValue;
}

// Bytes of JSON per inbox folder; keeps full paths under Windows' 260-char limit.
export const INBOX_CHUNK_BYTES = 100;

const LOG_PATTERN = /RC\|([0-9a-f]{8,32})\|([A-Z]+)\|([0-9a-f]*)(?:\|(\d{1,4})\/(\d{1,4})\/(\d{1,9}))?/;
const MAX_PARTS = 200;
const INBOX_PATTERN = /^(\d{8})\.(\d{3})\.(\d{3})\.([0-9a-f]*)$/;

export class WireError extends Error {
  override name = "WireError";
}

function hexToText(hex: string): string {
  if (hex.length % 2 !== 0) throw new WireError(`odd-length hex (${hex.length})`);
  return Buffer.from(hex, "hex").toString("utf8");
}

export interface RawLogLine {
  bridgeId: string;
  kind: OutboundKind;
  hex: string;
  part?: { index: number; count: number; msg: number };
}

// Returns null for log lines that aren't from a bridge.
export function parseRawLogLine(line: string): RawLogLine | null {
  const match = LOG_PATTERN.exec(line);
  if (!match) return null;
  const kind = match[2] as OutboundKind;
  if (!OUTBOUND_KINDS.includes(kind)) return null;
  const raw: RawLogLine = { bridgeId: match[1]!, kind, hex: match[3]! };
  if (match[4] !== undefined) raw.part = { index: Number(match[4]), count: Number(match[5]), msg: Number(match[6]) };
  return raw;
}

// A single-line message; null for other lines, including parts.
export function parseLogLine(line: string): OutboundLine | null {
  const raw = parseRawLogLine(line);
  if (!raw || raw.part) return null;
  return { bridgeId: raw.bridgeId, kind: raw.kind, payload: JSON.parse(hexToText(raw.hex)) as JsonValue };
}

// Joins parts back into messages. Parts of one message arrive in order and
// together, so an unfinished message is dropped when another one starts.
export class PartAssembler {
  private current: { key: string; count: number; hex: string[] } | undefined;

  push(raw: RawLogLine): OutboundLine | null {
    if (!raw.part) return { bridgeId: raw.bridgeId, kind: raw.kind, payload: JSON.parse(hexToText(raw.hex)) as JsonValue };
    const { index, count, msg } = raw.part;
    if (count < 1 || count > MAX_PARTS || index < 1 || index > count) return null;
    const key = `${raw.bridgeId}/${raw.kind}/${msg}`;
    if (index === 1 || this.current?.key !== key) this.current = { key, count, hex: [] };
    if (this.current.hex.length !== index - 1) {
      this.current = undefined; // a part went missing
      return null;
    }
    this.current.hex.push(raw.hex);
    if (index < count) return null;
    const hex = this.current.hex.join("");
    this.current = undefined;
    return { bridgeId: raw.bridgeId, kind: raw.kind, payload: JSON.parse(hexToText(hex)) as JsonValue };
  }
}

// Splits one message into inbox folder names. Chunks split the UTF-8 bytes,
// so a multi-byte character may straddle two folders; joining restores it.
export function encodeInboxFolders(seq: number, message: JsonValue): string[] {
  if (!Number.isInteger(seq) || seq < 0 || seq > 99_999_999) throw new WireError(`bad seq ${seq}`);
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  const parts = Math.max(1, Math.ceil(bytes.length / INBOX_CHUNK_BYTES));
  if (parts > 999) throw new WireError(`message too large (${bytes.length} bytes)`);
  const names: string[] = [];
  for (let i = 0; i < parts; i++) {
    const chunk = bytes.subarray(i * INBOX_CHUNK_BYTES, (i + 1) * INBOX_CHUNK_BYTES).toString("hex");
    names.push(`${String(seq).padStart(8, "0")}.${String(i + 1).padStart(3, "0")}.${String(parts).padStart(3, "0")}.${chunk}`);
  }
  return names;
}

export interface InboxFolder {
  seq: number;
  part: number;
  parts: number;
  hex: string;
}

export function parseInboxFolder(name: string): InboxFolder | null {
  const match = INBOX_PATTERN.exec(name);
  if (!match) return null;
  return { seq: Number(match[1]), part: Number(match[2]), parts: Number(match[3]), hex: match[4]! };
}

// Reassembles complete messages from folder names (in any order), oldest
// first. Incomplete messages are left out until all their parts exist.
export function decodeInbox(names: Iterable<string>): { seq: number; message: JsonValue }[] {
  const bySeq = new Map<number, InboxFolder[]>();
  for (const name of names) {
    const folder = parseInboxFolder(name);
    if (!folder) continue;
    const list = bySeq.get(folder.seq) ?? [];
    list.push(folder);
    bySeq.set(folder.seq, list);
  }
  const messages: { seq: number; message: JsonValue }[] = [];
  for (const [seq, folders] of [...bySeq].sort((a, b) => a[0] - b[0])) {
    const parts = folders[0]!.parts;
    if (folders.length !== parts) continue;
    const hex = folders.sort((a, b) => a.part - b.part).map((f) => f.hex).join("");
    messages.push({ seq, message: JSON.parse(hexToText(hex)) as JsonValue });
  }
  return messages;
}
