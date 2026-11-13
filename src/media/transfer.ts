// Sending media files between PCs (SPEC §10.4, §25.3). The asker asks one
// source for a session clip's proxy or original, then for its chunks, at
// most WINDOW at a time; each chunk carries its SHA-256 and the whole file's
// is checked at the end. Chunks travel "loose" (not kept for resending by
// the peer link): the asker asks again for any that don't come. A download
// is written to "<name>.part" with a ".part.json" of the chunks already
// there, so it carries on after a restart or from another source.
//
// The source only ever reads a file its own `prepare` picks for a session
// clip; nothing from the asker names a path.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

export const CHUNK = 128 * 1024;
const WINDOW = 6;
const CHUNK_TIMEOUT_MS = 10_000;
const ASK_TIMEOUT_MS = 30_000; // no answer to a request at all
const MAX_SIZE = 2 ** 42; // 4 TB: anything bigger is a bad offer
const CONCURRENT = 2;
const SAVE_EVERY_MS = 2000;
const SERVE_IDLE_MS = 5 * 60_000;

export type Kind = "proxy" | "original";
export type JsonObject = Record<string, unknown>;

// `as`: what's actually sent; an audio file or still is sent as the original when a proxy is asked for.
export interface Prepared { path: string; size: number; sha256: string; as?: Kind }

export interface TransferOptions {
  // Reliable (acknowledged) and loose messages to one peer; false if not connected.
  send: (peer: string, message: JsonObject) => boolean;
  sendLoose: (peer: string, message: JsonObject) => boolean;
  // Source side: may this peer have this clip's file? (an admitted person, a clip in the session)
  allowed: (peer: string, clip: string) => boolean;
  // Source side: the file to send, made first if it's a proxy; `progress` 0–1 while making.
  prepare: (clip: string, kind: Kind, progress: (p: number) => void) => Promise<Prepared | { error: string }>;
  // Asker side: an original's fingerprint check, done after the SHA-256.
  verify?: (clip: string, as: Kind, path: string) => Promise<boolean>;
  // Asker side: the size a file may be (an original: exactly; a proxy: at most), and whether there's room for it.
  sizeLimit?: (clip: string, as: Kind) => { exact: number } | { exact?: undefined; max: number } | undefined;
  room?: (bytes: number, dest: string) => Promise<boolean>;
  log: (message: string) => void;
  onChange?: () => void;
  now?: () => number;
  chunkTimeoutMs?: number; // tests: a lost chunk is asked for again sooner
}

export type State = "queued" | "asking" | "making" | "downloading" | "paused" | "waiting" | "verifying" | "done" | "failed";

export interface DownloadView {
  clip: string;
  kind: Kind;
  as: Kind; // what's coming: the original instead of a proxy for audio and stills
  state: State;
  source: string;
  size: number;
  received: number;
  making: number; // 0–1 while the source makes the proxy
  error: string;
  path: string;
}

interface Download extends DownloadView {
  dest: string;
  destFor: (as: Kind) => string;
  sources: () => string[]; // who has it, best first
  n: string; // this request's number
  sha256: string;
  have: Set<number>;
  inFlight: Map<number, number>; // chunk → asked at
  askedAt: number;
  savedAt: number;
  resolve?: (got: Got | undefined) => void;
}

export interface Got { path: string; as: Kind }

interface Serving { peer: string; clip: string; file?: Prepared; at: number }

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const count = (size: number) => Math.max(1, Math.ceil(size / CHUNK));
const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest("hex");
}

export class MediaTransfer {
  private readonly options: TransferOptions;
  private readonly downloads = new Map<string, Download>(); // by clip + kind
  private readonly serving = new Map<string, Serving>(); // by peer + n
  private timer: NodeJS.Timeout;
  private next = 1;

  constructor(options: TransferOptions) {
    this.options = options;
    this.timer = setInterval(() => this.tick(), Math.min(1000, (options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS) / 2));
    this.timer.unref();
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // --- asking -------------------------------------------------------------------

  // Downloads a clip's file to `destFor(what's sent)`; resolves with where it
  // went and what it is, or undefined if it failed or was cancelled. Asking
  // again for one in progress joins it.
  want(clip: string, kind: Kind, destFor: (as: Kind) => string, sources: () => string[]): Promise<Got | undefined> {
    const key = `${clip}:${kind}`;
    const existing = this.downloads.get(key);
    if (existing && existing.state !== "done" && existing.state !== "failed") {
      return new Promise((resolve) => {
        const before = existing.resolve;
        existing.resolve = (p) => { before?.(p); resolve(p); };
      });
    }
    return new Promise((resolve) => {
      this.downloads.set(key, {
        clip, kind, as: kind, dest: destFor(kind), destFor, sources, state: "queued", source: "", size: 0, received: 0, making: 0, error: "", path: "",
        n: "", sha256: "", have: new Set(), inFlight: new Map(), askedAt: 0, savedAt: 0, resolve,
      });
      this.startQueued();
      this.changed();
    });
  }

  list(): DownloadView[] {
    return [...this.downloads.values()].map(({ clip, kind, as, state, source, size, received, making, error, path }) => ({ clip, kind, as, state, source, size, received, making, error, path }));
  }

  pause(clip: string, kind: Kind): void {
    const d = this.downloads.get(`${clip}:${kind}`);
    if (!d || d.state === "done" || d.state === "failed") return;
    d.state = "paused";
    d.inFlight.clear();
    void this.save(d);
    this.startQueued();
    this.changed();
  }

  resume(clip: string, kind: Kind): void {
    const d = this.downloads.get(`${clip}:${kind}`);
    if (d?.state !== "paused") return;
    d.state = "queued";
    this.startQueued();
    this.changed();
  }

  cancel(clip: string, kind: Kind): void {
    const d = this.downloads.get(`${clip}:${kind}`);
    if (!d) return;
    this.downloads.delete(`${clip}:${kind}`);
    void this.save(d);
    d.resolve?.(undefined);
    this.startQueued();
    this.changed();
  }

  private active(): Download[] {
    return [...this.downloads.values()].filter((d) => ["asking", "making", "downloading", "verifying"].includes(d.state));
  }

  private startQueued(): void {
    for (const d of this.downloads.values()) {
      if (this.active().length >= CONCURRENT) return;
      if (d.state === "queued" || d.state === "waiting") this.ask(d);
    }
  }

  private ask(d: Download): void {
    const source = d.sources()[0];
    if (!source) {
      d.state = "waiting";
      return;
    }
    d.source = source;
    d.n = `${this.next++}`;
    d.state = "asking";
    d.askedAt = this.now;
    d.inFlight.clear();
    if (!this.options.send(source, { type: "media-get", n: d.n, clip: d.clip, kind: d.kind })) {
      d.state = "waiting";
    }
    this.changed();
  }

  private async offered(d: Download, m: JsonObject): Promise<void> {
    if (typeof m.error === "string") return this.fail(d, `${d.source} can't send it: ${m.error.slice(0, 100)}`, true);
    if (m.state === "making") {
      d.state = "making";
      d.making = typeof m.progress === "number" ? Math.min(1, Math.max(0, m.progress)) : 0;
      d.askedAt = this.now;
      return this.changed();
    }
    const size = m.size;
    if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_SIZE || !isHex64(m.sha256)) return this.fail(d, "a bad offer", true);
    d.as = m.as === "original" ? "original" : d.kind;
    // No more than this clip can be (security review): a source can't fill the disk.
    const limit = this.options.sizeLimit?.(d.clip, d.as);
    if (limit && (limit.exact !== undefined ? size !== limit.exact : (size as number) > limit.max)) return this.fail(d, `${d.source} offered a file of the wrong size`, true);
    d.dest = d.destFor(d.as);
    if (this.options.room && !(await this.options.room(size as number, d.dest))) {
      d.state = "paused";
      d.error = "not enough free space";
      this.options.log(`not enough free space for ${d.dest}; paused`);
      return this.changed();
    }
    // The same file as a download already partly here? Then carry on from its chunks.
    const part = await this.loadPart(d.dest);
    d.have = part && part.size === size && part.sha256 === m.sha256 ? new Set(part.have) : new Set();
    d.size = size as number;
    d.sha256 = m.sha256;
    d.received = Math.min(d.size, d.have.size * CHUNK);
    await mkdir(dirname(d.dest), { recursive: true });
    if (!d.have.size) await writeFile(`${d.dest}.part`, Buffer.alloc(0));
    d.state = "downloading";
    this.pump(d);
    this.changed();
  }

  private pump(d: Download): void {
    if (d.state !== "downloading") return;
    const total = count(d.size);
    if (d.have.size === total) return void this.finish(d);
    for (let i = 0; i < total && d.inFlight.size < WINDOW; i++) {
      if (d.have.has(i) || d.inFlight.has(i)) continue;
      d.inFlight.set(i, this.now);
      this.options.sendLoose(d.source, { type: "media-chunk-get", n: d.n, i });
    }
  }

  private async chunk(d: Download, m: JsonObject): Promise<void> {
    const i = m.i;
    if (d.state !== "downloading" || !Number.isSafeInteger(i) || !d.inFlight.has(i as number) || typeof m.d !== "string" || !isHex64(m.h)) return;
    const data = Buffer.from(m.d, "base64");
    const total = count(d.size);
    const expected = (i as number) === total - 1 ? d.size - (total - 1) * CHUNK : CHUNK;
    d.inFlight.delete(i as number);
    if (data.length !== expected || sha(data) !== m.h) {
      this.options.log(`a damaged chunk of a download was refused; asking again`);
      return this.pump(d);
    }
    const file = await open(`${d.dest}.part`, "r+");
    try { await file.write(data, 0, data.length, (i as number) * CHUNK); } finally { await file.close(); }
    if (this.downloads.get(`${d.clip}:${d.kind}`) !== d || d.state !== "downloading") return;
    d.have.add(i as number);
    d.received = Math.min(d.size, d.received + data.length);
    if (this.now - d.savedAt > SAVE_EVERY_MS) void this.save(d);
    this.pump(d);
    this.changed();
  }

  private async finish(d: Download): Promise<void> {
    if (d.state !== "downloading") return;
    d.state = "verifying";
    this.changed();
    const part = `${d.dest}.part`;
    const got = await sha256File(part);
    if (got !== d.sha256) {
      await rm(part, { force: true });
      await rm(`${part}.json`, { force: true });
      return this.fail(d, "the file arrived damaged (its SHA-256 doesn't match)");
    }
    if (this.options.verify && !(await this.options.verify(d.clip, d.as, part))) {
      await rm(part, { force: true });
      await rm(`${part}.json`, { force: true });
      return this.fail(d, "the file isn't the session's clip (its fingerprint doesn't match)");
    }
    const dest = await free(d.dest);
    await rename(part, dest);
    await rm(`${part}.json`, { force: true });
    d.state = "done";
    d.path = dest;
    this.downloads.delete(`${d.clip}:${d.kind}`);
    d.resolve?.({ path: dest, as: d.as });
    this.startQueued();
    this.changed();
  }

  private fail(d: Download, why: string, tryAnother = false): void {
    if (tryAnother && d.sources().some((s) => s !== d.source)) {
      this.options.log(`${why}; trying someone else`);
      const tried = d.source;
      const others = d.sources;
      d.sources = () => others().filter((s) => s !== tried);
      d.state = "queued";
      this.startQueued();
      return this.changed();
    }
    d.state = "failed";
    d.error = why;
    this.options.log(why);
    this.downloads.delete(`${d.clip}:${d.kind}`);
    d.resolve?.(undefined);
    this.startQueued();
    this.changed();
  }

  // A source went: its downloads wait for another one (they keep their chunks).
  peerLeft(peer: string): void {
    for (const d of this.downloads.values()) {
      if (d.source === peer && ["asking", "making", "downloading"].includes(d.state)) {
        void this.save(d);
        d.state = "waiting";
      }
    }
    for (const [k, s] of this.serving) if (s.peer === peer) this.serving.delete(k);
    this.startQueued();
    this.changed();
  }

  // Someone joined or came back: waiting downloads may have a source now.
  peerJoined(): void {
    this.startQueued();
  }

  private tick(): void {
    const now = this.now;
    for (const d of this.downloads.values()) {
      if ((d.state === "asking" || d.state === "making") && now - d.askedAt > ASK_TIMEOUT_MS) {
        d.state = "waiting";
        this.changed();
      }
      if (d.state === "downloading") {
        let late = false;
        for (const [i, at] of d.inFlight) if (now - at > (this.options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS)) { d.inFlight.delete(i); late = true; }
        if (late) this.pump(d);
      }
    }
    for (const [k, s] of this.serving) if (now - s.at > SERVE_IDLE_MS) this.serving.delete(k);
    if ([...this.downloads.values()].some((d) => d.state === "waiting" || d.state === "queued")) this.startQueued();
  }

  private async loadPart(dest: string): Promise<{ size: number; sha256: string; have: number[] } | undefined> {
    try {
      const j = JSON.parse(await readFile(`${dest}.part.json`, "utf8")) as { size?: unknown; sha256?: unknown; have?: unknown };
      const size = (await stat(`${dest}.part`)).size;
      if (!Number.isSafeInteger(j.size) || !isHex64(j.sha256) || !Array.isArray(j.have) || size === 0) return undefined;
      return { size: j.size as number, sha256: j.sha256, have: j.have.filter((i): i is number => Number.isSafeInteger(i) && i >= 0 && i < count(j.size as number)) };
    } catch {
      return undefined;
    }
  }

  private async save(d: Download): Promise<void> {
    if (!d.size || !existsSync(`${d.dest}.part`)) return;
    d.savedAt = this.now;
    try {
      await writeFile(`${d.dest}.part.json`, JSON.stringify({ size: d.size, sha256: d.sha256, have: [...d.have] }));
    } catch { /* the next save tries again */ }
  }

  // --- sending --------------------------------------------------------------------

  async message(from: string, m: JsonObject): Promise<void> {
    switch (m.type) {
      case "media-get": return this.get(from, m);
      case "media-chunk-get": return this.chunkGet(from, m);
      case "media-offer": {
        const d = [...this.downloads.values()].find((x) => x.n === m.n && x.source === from);
        if (d && (d.state === "asking" || d.state === "making")) await this.offered(d, m);
        return;
      }
      case "media-chunk": {
        const d = [...this.downloads.values()].find((x) => x.n === m.n && x.source === from);
        if (d) await this.chunk(d, m);
        return;
      }
    }
  }

  private async get(from: string, m: JsonObject): Promise<void> {
    const n = typeof m.n === "string" ? m.n.slice(0, 20) : "";
    const clip = typeof m.clip === "string" ? m.clip : "";
    const kind = m.kind === "proxy" || m.kind === "original" ? m.kind : undefined;
    if (!n || !kind || !this.options.allowed(from, clip)) {
      this.options.send(from, { type: "media-offer", n, error: "not available" });
      return;
    }
    const serving: Serving = { peer: from, clip, at: this.now };
    this.serving.set(`${from}:${n}`, serving);
    let last = 0;
    let progress = 0;
    const making = () => {
      last = this.now;
      serving.at = this.now;
      this.options.sendLoose(from, { type: "media-offer", n, state: "making", progress });
    };
    // Also while waiting its turn (proxies are made one at a time): the asker keeps waiting.
    const still = setInterval(making, 10_000);
    const result = await this.options.prepare(clip, kind, (p) => {
      progress = p;
      if (this.now - last >= 1000) making();
    }).finally(() => clearInterval(still));
    if ("error" in result) {
      this.serving.delete(`${from}:${n}`);
      this.options.send(from, { type: "media-offer", n, error: result.error });
      return;
    }
    serving.file = result;
    serving.at = this.now;
    this.options.send(from, { type: "media-offer", n, size: result.size, sha256: result.sha256, as: result.as ?? kind, ext: extname(result.path).slice(0, 10) });
  }

  private async chunkGet(from: string, m: JsonObject): Promise<void> {
    const s = this.serving.get(`${from}:${String(m.n)}`);
    const i = m.i;
    if (!s?.file || !Number.isSafeInteger(i) || (i as number) < 0 || (i as number) >= count(s.file.size)) return;
    s.at = this.now;
    const length = Math.min(CHUNK, s.file.size - (i as number) * CHUNK);
    const data = Buffer.alloc(length);
    const file = await open(s.file.path, "r");
    try { await file.read(data, 0, length, (i as number) * CHUNK); } finally { await file.close(); }
    this.options.sendLoose(from, { type: "media-chunk", n: m.n, i, d: data.toString("base64"), h: sha(data) });
  }

  // What this PC is sending, for the Media panel ("Kim is getting … from you").
  sending(): { peer: string; clip: string; making: boolean }[] {
    return [...this.serving.values()].map((s) => ({ peer: s.peer, clip: s.clip, making: !s.file }));
  }

  stop(): void {
    clearInterval(this.timer);
    for (const d of this.downloads.values()) void this.save(d);
  }

  private changed(): void {
    this.options.onChange?.();
  }
}

// A file name not taken yet: "name.ext", else "name (2).ext", "name (3).ext" …
async function free(path: string): Promise<string> {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let k = 2; k < 1000; k++) if (!existsSync(`${stem} (${k})${ext}`)) return `${stem} (${k})${ext}`;
  throw new Error(`no free name for ${path}`);
}
