// Companion side of the bridge channel (SPEC §3.2, §18.1): follows Resolve's
// debug log for bridge output and writes commands as inbox folders.

import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type JsonValue, type OutboundLine, PartAssembler, encodeInboxFolders, parseInboxFolder, parseRawLogLine, parseReadyFolder, readyFolder } from "../bridge-protocol/wire.ts";

export interface BridgeClientOptions {
  logPath: string; // Support/logs/ResolveDebug.txt
  inboxDir: string;
  pollMs?: number;
  commandTimeoutMs?: number;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
  [key: string]: JsonValue | undefined;
}

interface Pending {
  command: { type: string } & Record<string, JsonValue>;
  resolve: (result: CommandResult) => void;
  timer: NodeJS.Timeout;
}

const inboxSeq = (name: string): number | null => parseInboxFolder(name)?.seq ?? parseReadyFolder(name);

// Events: "hello" (payload), "attached" (a bridge that was already running
// when this client started), "event" (payload), "error" (payload),
// "alive" (boolean).
export class BridgeClient extends EventEmitter {
  private readonly logPath: string;
  private readonly inboxDir: string;
  private readonly pollMs: number;
  private readonly commandTimeoutMs: number;
  private offset = 0;
  private partial = "";
  private timer: NodeJS.Timeout | undefined;
  private bridgeId: string | undefined;
  private lastBeat = 0;
  private alive = false;
  private nextSeq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiting = new Set<Pending>(); // sent before the bridge was seen
  private readonly parts = new PartAssembler();

  constructor(options: BridgeClientOptions) {
    super();
    this.logPath = options.logPath;
    this.inboxDir = options.inboxDir;
    this.pollMs = options.pollMs ?? 50;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
  }

  // Starts reading from the current end of the log, so output from earlier
  // bridge runs is ignored, and clears messages a previous run left behind.
  start(): void {
    mkdirSync(this.inboxDir, { recursive: true });
    for (const name of readdirSync(this.inboxDir)) {
      if (inboxSeq(name) !== null) rmSync(join(this.inboxDir, name), { recursive: true, force: true });
    }
    this.offset = this.logSize();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "stopped" });
    }
    for (const waiting of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, error: "stopped" });
    }
    this.pending.clear();
    this.waiting.clear();
  }

  get connected(): boolean {
    return this.alive;
  }

  // Commands wait until the bridge has said which sequence numbers it has
  // already handled, since a running bridge ignores numbers it has seen.
  send(command: { type: string } & Record<string, JsonValue>): Promise<CommandResult> {
    return new Promise((resolve) => {
      const entry: Pending = {
        command,
        resolve,
        timer: setTimeout(() => {
          this.waiting.delete(entry);
          for (const [seq, pending] of this.pending) if (pending === entry) this.pending.delete(seq);
          resolve({ ok: false, error: "timeout" });
        }, this.commandTimeoutMs),
      };
      if (this.bridgeId === undefined) this.waiting.add(entry);
      else this.write(entry);
    });
  }

  private write(entry: Pending): void {
    const seq = this.nextSeq++;
    this.pending.set(seq, entry);
    for (const name of encodeInboxFolders(seq, entry.command)) mkdirSync(join(this.inboxDir, name));
    mkdirSync(join(this.inboxDir, readyFolder(seq)));
  }

  private dropInFlight(error: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
    for (const name of readdirSync(this.inboxDir)) {
      if (inboxSeq(name) !== null) rmSync(join(this.inboxDir, name), { recursive: true, force: true });
    }
  }

  private flushWaiting(): void {
    for (const entry of this.waiting) this.write(entry);
    this.waiting.clear();
  }

  private seeHandled(payload: JsonValue): void {
    const handled = (payload as Record<string, JsonValue> | null)?.handled;
    if (typeof handled === "number" && Number.isSafeInteger(handled) && handled >= this.nextSeq) this.nextSeq = handled + 1;
  }

  private logSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  private poll(): void {
    for (const line of this.readNewLines()) {
      const raw = parseRawLogLine(line);
      if (!raw) continue;
      let message: OutboundLine | null;
      try {
        message = this.parts.push(raw);
      } catch {
        continue; // a damaged line; the bridge's next snapshot repairs it
      }
      if (message) this.handle(message);
    }
    const alive = this.bridgeId !== undefined && Date.now() - this.lastBeat < 3000;
    if (alive !== this.alive) {
      this.alive = alive;
      this.emit("alive", alive);
    }
  }

  // Resolve replaces the log when it restarts; a shrinking file starts over.
  private readNewLines(): string[] {
    const size = this.logSize();
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.logPath, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + buffer.toString("utf8")).split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    return lines;
  }

  private handle({ bridgeId, kind, payload }: OutboundLine): void {
    if (kind === "HELLO") {
      // A new bridge run counts inbox messages from its own start: what was
      // written for the old run is cleared, and commands in flight fail (the
      // syncs make them again).
      if (this.bridgeId !== undefined && this.bridgeId !== bridgeId) this.dropInFlight("bridge-restarted");
      this.bridgeId = bridgeId;
      this.lastBeat = Date.now();
      const handled = (payload as Record<string, JsonValue> | null)?.handled;
      this.nextSeq = (typeof handled === "number" && Number.isSafeInteger(handled) && handled >= 0 ? handled : 0) + 1;
      this.flushWaiting();
      this.emit("hello", payload);
      return;
    }
    // A bridge already running when this client started: its heartbeat says
    // how far it has got.
    if (kind === "HB" && this.bridgeId === undefined) {
      this.bridgeId = bridgeId;
      this.seeHandled(payload);
      this.flushWaiting();
      this.emit("attached");
    }
    if (bridgeId !== this.bridgeId) return; // output of an older bridge run
    this.lastBeat = Date.now();
    const data = payload as Record<string, JsonValue>;
    switch (kind) {
      case "ACK":
        this.removeAcknowledged(Number(data.seq));
        break;
      case "RES":
        this.settle(Number(data.seq), data as unknown as CommandResult);
        break;
      case "EVT":
        this.emit("event", payload);
        break;
      case "ERR":
        this.emit("error", payload);
        break;
      case "HB":
        this.seeHandled(payload);
        break;
    }
  }

  private removeAcknowledged(upTo: number): void {
    for (const name of readdirSync(this.inboxDir)) {
      const seq = inboxSeq(name);
      if (seq !== null && seq <= upTo) rmSync(join(this.inboxDir, name), { recursive: true, force: true });
    }
  }

  private settle(seq: number, result: CommandResult): void {
    const pending = this.pending.get(seq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(seq);
    pending.resolve(result);
  }
}
