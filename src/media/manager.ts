// Missing media (SPEC §10, §25): who has what, proxies fetched by themselves,
// originals on request, a proxy standing in for a clip until its original
// comes, and serving other PCs from this PC's own media pool.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clip, Fingerprint } from "../sync/media-pool.ts";
import type { BridgeResult } from "../sync/media-pool-sync.ts";
import { defaultMediaFolder, mediaPath } from "./paths.ts";
import { ProxyCache, classify } from "./proxy.ts";
import { type DownloadView, type Got, type JsonObject, type Kind, MediaTransfer, type Prepared, sha256File } from "./transfer.ts";

const ASK_ABOVE = 5 * 1024 ** 3; // a batch of proxies bigger than this is asked first (§25.1)
const PROXY_SHARE = 0.2; // a proxy is about this share of its original (the probe: a seventh)
const HAVE_MAX = 50_000;

export interface MediaSync {
  readonly missing: Map<string, { id: string; name: string }>;
  sessionClip(id: string): Clip | undefined;
  sessionClips(): Clip[];
  binNames(id: string): string[];
  localPath(id: string): string | undefined;
  importAs(id: string, path: string): Promise<BridgeResult>;
  linkFull(id: string, path: string): Promise<BridgeResult>;
}

export interface MediaManagerOptions {
  me: string;
  store: string; // media.json in the session's folder
  proxies: string; // the companion's proxy folder
  project: () => string;
  sync: MediaSync;
  fingerprint: (path: string) => Promise<Fingerprint | null>;
  send: (peer: string, message: JsonObject) => boolean;
  sendLoose: (peer: string, message: JsonObject) => boolean;
  announce: (have: { originals: string[]; proxies: string[] }) => void; // to everyone, through the host
  online: () => string[]; // the others here, host first, then in join order
  isPerson: (peer: string) => boolean;
  nameOf: (peer: string) => string;
  log: (message: string) => void;
  onChange?: () => void;
}

interface Store {
  folder?: string;
  standIns: Record<string, string>; // clip → its proxy file
  downloaded: Record<string, string>; // clip → its original, downloaded here
  approved: string[]; // clips whose proxies were OK'd in a batch over 5 GB
  later: string[]; // clips the person said "Not now" to
}

export type Ask = { kind: "folder"; path: string } | { kind: "big"; clips: string[]; bytes: number; free: number };

export interface MediaItem {
  id: string;
  name: string;
  bin: string;
  state: "noproxy" | "downloading" | "queued" | "paused" | "proxy" | "waiting" | "here" | "failed";
  kind: Kind;
  progress: number; // 0–1
  got: number; // bytes in, while downloading
  total: number; // bytes coming, once known
  making: boolean;
  from: string;
  size: number; // the original's
  note: string;
}

export class MediaManager {
  private readonly options: MediaManagerOptions;
  private readonly transfer: MediaTransfer;
  private readonly cache: ProxyCache;
  private store: Store;
  private readonly haveOf = new Map<string, { originals: Set<string>; proxies: Set<string> }>();
  private readonly fps = new Map<string, { key: string; fp: Fingerprint | null }>(); // path → its fingerprint, by size and time
  private readonly shas = new Map<string, { key: string; sha: string }>();
  private readonly noProxy = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly wanted = new Set<string>(); // clip:kind being fetched
  private lastHave = "";
  private mine: { originals: string[]; proxies: string[] } = { originals: [], proxies: [] };
  private asking: Ask | undefined;
  private timer: NodeJS.Timeout | undefined;
  private usage = { at: 0, bytes: 0, free: 0 };
  private stopped = false;
  private readonly beat: NodeJS.Timeout;

  constructor(options: MediaManagerOptions) {
    this.options = options;
    this.cache = new ProxyCache(options.proxies);
    this.store = { standIns: {}, downloaded: {}, approved: [], later: [], ...load(options.store) };
    this.transfer = new MediaTransfer({
      send: options.send,
      sendLoose: options.sendLoose,
      allowed: (peer, clip) => options.isPerson(peer) && !!options.sync.sessionClip(clip),
      prepare: (clip, kind, progress) => this.prepare(clip, kind, progress),
      verify: (clip, as, path) => this.verify(clip, as, path),
      log: options.log,
      onChange: () => this.changed(),
    });
    // New clips, a clip gone missing, a file found: looked at again every 3 s (fingerprints are kept).
    this.beat = setInterval(() => this.schedule(), 3000);
    this.beat.unref();
    this.schedule();
  }

  // --- what's going on, for the window ----------------------------------------------

  get ask(): Ask | undefined {
    return this.asking;
  }

  get standIns(): number {
    return Object.keys(this.store.standIns).length;
  }

  get folder(): string {
    return this.store.folder ?? defaultMediaFolder(this.options.project());
  }

  items(): MediaItem[] {
    const { sync } = this.options;
    const downloads = new Map(this.transfer.list().map((d) => [d.clip, d]));
    const out: MediaItem[] = [];
    const ids = new Set([...sync.missing.keys(), ...Object.keys(this.store.standIns), ...Object.keys(this.store.downloaded), ...downloads.keys()]);
    for (const id of ids) {
      const clip = sync.sessionClip(id);
      if (!clip) continue;
      const d = downloads.get(id);
      const item: MediaItem = { id, name: clip.name, bin: sync.binNames(id).join(" / "), state: "here", kind: "original", progress: 0, got: 0, total: 0, making: false, from: "", size: clip.file?.size ?? 0, note: "" };
      if (d) Object.assign(item, this.fromDownload(d));
      else if (this.store.standIns[id]) Object.assign(item, { state: "proxy", kind: "proxy" });
      else if (this.store.downloaded[id] && !sync.missing.has(id)) Object.assign(item, { state: "here" });
      else if (this.noProxy.has(id)) Object.assign(item, { state: "noproxy" });
      else if (this.failed.has(id)) Object.assign(item, { state: "failed", note: this.failed.get(id) });
      else Object.assign(item, { state: "waiting", note: this.sources(id, "proxy").length ? "" : this.nobody(id) });
      out.push(item);
    }
    return out;
  }

  private fromDownload(d: DownloadView): Partial<MediaItem> {
    const state = d.state === "paused" ? "paused" : d.state === "queued" ? "queued" : d.state === "waiting" ? "waiting" : "downloading";
    return { state, kind: d.as, progress: d.size ? d.received / d.size : d.making, got: d.received, total: d.size, making: d.state === "making", from: d.source ? this.options.nameOf(d.source) : "" };
  }

  private nobody(id: string): string {
    const holders = [...this.haveOf].filter(([, h]) => h.originals.has(id) || h.proxies.has(id)).map(([p]) => this.options.nameOf(p));
    return holders.length ? `Only ${holders.join(", ")} has it, and they're offline` : "No one here has it right now";
  }

  sending(): { name: string; clip: string; making: boolean }[] {
    return this.transfer.sending().map((s) => ({ name: this.options.nameOf(s.peer), clip: this.options.sync.sessionClip(s.clip)?.name ?? "a clip", making: s.making }));
  }

  // Space used by the media folder and free on its drive, looked at every 30 s.
  space(): { used: number; free: number } {
    if (Date.now() - this.usage.at > 30_000) {
      this.usage.at = Date.now();
      void (async () => {
        this.usage.bytes = await folderSize(this.folder);
        this.usage.free = await freeSpace(this.folder);
        this.changed();
      })();
    }
    return { used: this.usage.bytes, free: this.usage.free };
  }

  // --- who has what -----------------------------------------------------------------

  haveArrived(peer: string, m: JsonObject): void {
    const list = (v: unknown) => new Set((Array.isArray(v) ? v : []).slice(0, HAVE_MAX).filter((x): x is string => typeof x === "string" && x.length <= 64));
    this.haveOf.set(peer, { originals: list(m.originals), proxies: list(m.proxies) });
    this.schedule();
  }

  // What everyone has, for a newcomer (the host sends it with the welcome).
  haveList(): { id: string; originals: string[]; proxies: string[] }[] {
    return [{ id: this.options.me, ...this.mine }, ...[...this.haveOf].map(([id, h]) => ({ id, originals: [...h.originals], proxies: [...h.proxies] }))];
  }

  peerLeft(peer: string): void {
    this.transfer.peerLeft(peer);
    this.schedule();
  }

  peerJoined(): void {
    this.lastHave = ""; // tell the newcomer too
    this.transfer.peerJoined();
    this.schedule();
  }

  private sources(id: string, kind: Kind): string[] {
    return this.options.online().filter((p) => {
      const h = this.haveOf.get(p);
      return h && (h.originals.has(id) || (kind === "proxy" && h.proxies.has(id)));
    });
  }

  // --- the pass ---------------------------------------------------------------------

  schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pass().catch((e) => this.options.log(`media pass failed: ${(e as Error).message}`)), 200);
  }

  private async pass(): Promise<void> {
    await this.announce();
    const { sync } = this.options;
    // Proxies for missing clips, by themselves (§25.1): the folder asked once, a big batch asked first.
    const want = [...sync.missing.keys()].filter((id) => !this.store.standIns[id] && !this.noProxy.has(id) && !this.failed.has(id)
      && !this.store.later.includes(id) && !this.wanted.has(`${id}:proxy`) && !this.wanted.has(`${id}:original`) && this.sources(id, "proxy").length);
    if (!want.length) return this.setAsk(this.asking?.kind === "big" ? undefined : this.asking);
    if (!this.store.folder) return this.setAsk({ kind: "folder", path: defaultMediaFolder(this.options.project()) });
    const fresh = want.filter((id) => !this.store.approved.includes(id));
    const bytes = fresh.reduce((n, id) => n + (sync.sessionClip(id)?.file?.size ?? 0) * PROXY_SHARE, 0);
    if (bytes > ASK_ABOVE) return this.setAsk({ kind: "big", clips: fresh, bytes, free: await freeSpace(this.folder) });
    this.setAsk(undefined);
    for (const id of want) void this.fetch(id, "proxy");
  }

  private async announce(): Promise<void> {
    const originals: string[] = [];
    for (const clip of this.options.sync.sessionClips()) {
      const path = this.options.sync.localPath(clip.id);
      if (path && clip.file && !this.store.standIns[clip.id] && (await this.matches(path, clip.file))) originals.push(clip.id);
    }
    const proxies = Object.keys(this.store.standIns).filter((id) => existsSync(this.store.standIns[id]!));
    const key = JSON.stringify([originals, proxies]);
    if (key === this.lastHave) return;
    this.lastHave = key;
    this.mine = { originals, proxies };
    this.options.announce({ originals, proxies });
  }

  private setAsk(ask: Ask | undefined): void {
    if (JSON.stringify(ask) === JSON.stringify(this.asking)) return;
    this.asking = ask;
    this.changed();
  }

  // --- what the person does ---------------------------------------------------------

  useFolder(path: string | undefined): void {
    this.store.folder = path || defaultMediaFolder(this.options.project());
    this.save();
    this.setAsk(undefined);
    this.schedule();
  }

  answerBig(yes: boolean): void {
    const ask = this.asking;
    if (ask?.kind !== "big") return;
    if (yes) this.store.approved.push(...ask.clips);
    else this.store.later.push(...ask.clips);
    this.save();
    this.setAsk(undefined);
    this.schedule();
  }

  // Download this clip's proxy now (one the person had put off) or its original.
  original(id: string): void {
    this.store.later = this.store.later.filter((x) => x !== id);
    this.failed.delete(id);
    if (!this.store.folder) return this.setAsk({ kind: "folder", path: defaultMediaFolder(this.options.project()) });
    void this.fetch(id, "original");
  }

  allOriginals(): void {
    for (const item of this.items()) if (item.state === "proxy" || item.state === "noproxy" || item.state === "failed") this.original(item.id);
  }

  pause(id: string): void {
    for (const k of ["proxy", "original"] as const) this.transfer.pause(id, k);
  }

  resume(id: string): void {
    for (const k of ["proxy", "original"] as const) this.transfer.resume(id, k);
  }

  // The person's own copy (§10.2 "Locate file…"): checked by fingerprint.
  async locate(id: string, path: string): Promise<string> {
    const clip = this.options.sync.sessionClip(id);
    if (!clip?.file) return "that clip isn't in the session";
    if (!(await this.matches(path, clip.file))) return `${path} is not the same file as ${clip.name}`;
    this.transfer.cancel(id, "proxy");
    this.transfer.cancel(id, "original");
    return this.arrived(id, { path, as: "original" }, false);
  }

  // --- fetching ---------------------------------------------------------------------

  private async fetch(id: string, kind: Kind): Promise<void> {
    const clip = this.options.sync.sessionClip(id);
    if (!clip || this.wanted.has(`${id}:${kind}`)) return;
    this.wanted.add(`${id}:${kind}`);
    this.changed();
    try {
      const bins = this.options.sync.binNames(id);
      const got = await this.transfer.want(id, kind, (as) => mediaPath(this.folder, bins, clip.file?.name ?? clip.name, as), () => this.sources(id, kind));
      if (!got) {
        if (kind === "proxy") this.failed.set(id, "The download didn't work; try Download original");
        return;
      }
      await this.arrived(id, got, true);
    } catch (e) {
      this.failed.set(id, (e as Error).message);
    } finally {
      this.wanted.delete(`${id}:${kind}`);
      this.changed();
      this.schedule();
    }
  }

  private async arrived(id: string, got: Got, downloaded: boolean): Promise<string> {
    const { sync, log } = this.options;
    const name = sync.sessionClip(id)?.name ?? "the clip";
    const standIn = this.store.standIns[id];
    let result: BridgeResult;
    if (got.as === "original" && standIn && sync.localPath(id)) {
      result = await sync.linkFull(id, got.path);
      if (result.ok) delete this.store.standIns[id];
    } else {
      result = await sync.importAs(id, got.path);
      if (result.ok && got.as === "proxy") this.store.standIns[id] = got.path;
    }
    if (result.ok && got.as === "original" && downloaded) this.store.downloaded[id] = got.path;
    this.save();
    this.changed();
    const what = got.as === "proxy" ? "its proxy" : "the original";
    if (!result.ok) {
      log(`couldn't put ${what} of ${name} into Resolve: ${result.error}`);
      return `couldn't put ${what} of ${name} into Resolve (${result.error})`;
    }
    log(`${name}: ${what} is in Resolve`);
    return `${name}: ${what} is in Resolve`;
  }

  private async verify(id: string, as: Kind, path: string): Promise<boolean> {
    if (as === "proxy") return true; // made by the source; its SHA-256 was checked
    const file = this.options.sync.sessionClip(id)?.file;
    return !!file && (await this.matches(path, file));
  }

  // --- serving ----------------------------------------------------------------------

  async message(from: string, m: JsonObject): Promise<void> {
    if (m.type === "media-offer" && typeof m.error === "string" && /no proxy/.test(m.error)) {
      const d = this.transfer.list().find((x) => x.source === from && x.kind === "proxy");
      if (d) this.noProxy.add(d.clip);
    }
    await this.transfer.message(from, m);
  }

  private async prepare(id: string, kind: Kind, progress: (p: number) => void): Promise<Prepared | { error: string }> {
    const { sync } = this.options;
    const clip = sync.sessionClip(id);
    const path = sync.localPath(id);
    const original = clip?.file && path && !this.store.standIns[id] && (await this.matches(path, clip.file)) ? path : undefined;
    if (kind === "original") return original ? this.prepared(original, "original") : { error: "not here" };
    if (!original) {
      const standIn = this.store.standIns[id];
      return standIn && existsSync(standIn) ? this.prepared(standIn, "proxy") : { error: "not here" };
    }
    const what = await classify(original);
    if (what.kind === "audio" || what.kind === "still") return this.prepared(original, "original");
    if (what.kind === "unreadable") return { error: "no proxy possible" };
    try {
      return this.prepared(await this.cache.get(clip!.file!.hash, original, what.duration, progress), "proxy");
    } catch (e) {
      return { error: `the proxy couldn't be made (${(e as Error).message.slice(0, 80)})` };
    }
  }

  private async prepared(path: string, as: Kind): Promise<Prepared> {
    const info = await stat(path);
    const key = `${info.size}:${info.mtimeMs}`;
    let sha = this.shas.get(path);
    if (sha?.key !== key) {
      sha = { key, sha: await sha256File(path) };
      this.shas.set(path, sha);
    }
    return { path, size: info.size, sha256: sha.sha, as };
  }

  private async matches(path: string, file: Fingerprint): Promise<boolean> {
    let info;
    try { info = statSync(path); } catch { return false; }
    if (info.size !== file.size) return false;
    const key = `${info.size}:${info.mtimeMs}`;
    let fp = this.fps.get(path);
    if (fp?.key !== key) {
      fp = { key, fp: await this.options.fingerprint(path) };
      this.fps.set(path, fp);
    }
    return fp.fp?.hash === file.hash;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    this.transfer.stop();
  }

  private save(): void {
    void writeFile(this.options.store, JSON.stringify(this.store)).catch(() => {});
  }

  private changed(): void {
    this.options.onChange?.();
  }
}

function load(path: string): Partial<Store> {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    const map = (v: unknown) => Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([, p]) => typeof p === "string")) as Record<string, string>;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { ...(typeof j.folder === "string" ? { folder: j.folder } : {}), standIns: map(j.standIns), downloaded: map(j.downloaded), approved: ids(j.approved), later: ids(j.later) };
  } catch {
    return {};
  }
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += await folderSize(p);
      else if (e.isFile()) total += (await stat(p)).size;
    }
  } catch { /* not made yet */ }
  return total;
}

async function freeSpace(dir: string): Promise<number> {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const s = await statfs(at);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}
