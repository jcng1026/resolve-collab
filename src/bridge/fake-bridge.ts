// In-process stand-in for the Lua bridge, speaking the same wire format
// (SPEC §18.1) through a log file and an inbox folder. Used by tests and by
// the one-PC end-to-end check.

import { appendFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { type JsonValue, decodeInbox } from "../bridge-protocol/wire.ts";

export interface FakeClip {
  timeline: string;
  track: number;
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
  media: { name: string; path: string; frames: number };
}

export class FakeBridge {
  readonly id = randomBytes(4).toString("hex");
  readonly clips: FakeClip[] = [];
  readonly media = new Set<string>();
  private lastHandled = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly logPath: string;
  private readonly inboxDir: string;

  constructor(logPath: string, inboxDir: string) {
    this.logPath = logPath;
    this.inboxDir = inboxDir;
  }

  start(pollMs = 20): void {
    this.emit("HELLO", { product: "Fake Resolve", studio: false, inbox: this.inboxDir });
    this.timer = setInterval(() => this.tick(), pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // Simulates the editor appending a clip in this Resolve.
  addLocalClip(clip: FakeClip): void {
    this.clips.push(clip);
    this.emit("EVT", { type: "clip.added", ...clip } as unknown as JsonValue);
  }

  private emit(kind: string, payload: JsonValue): void {
    const hex = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
    appendFileSync(this.logPath, `[0x0] | Fusion | ERROR | fake | [string "???"]:1: RC|${this.id}|${kind}|${hex}\n`);
  }

  private tick(): void {
    this.emit("HB", {});
    let names: string[];
    try {
      names = readdirSync(this.inboxDir);
    } catch {
      return;
    }
    for (const { seq, message } of decodeInbox(names)) {
      if (seq <= this.lastHandled) continue;
      this.lastHandled = seq;
      this.emit("RES", { seq, ...this.apply(message as Record<string, JsonValue>) });
      this.emit("ACK", { seq });
    }
  }

  private apply(command: Record<string, JsonValue>): Record<string, JsonValue> {
    if (command.type !== "clip.append") return { ok: false, error: "unknown-command" };
    const clip = command as unknown as FakeClip;
    if (!this.media.has(clip.media.name)) return { ok: false, error: "media-missing" };
    this.clips.push(clip);
    return { ok: true };
  }
}
