// Peer-to-peer link between companions (SPEC §3.1, §18.3): Hyperswarm finds
// peers on a topic derived from the invite secret; connections are
// Noise-encrypted. Messages are newline-delimited JSON.
//
// M2 scope: anyone who knows the secret can connect and nothing is ordered or
// locked. Host approval and ordering arrive in M6/M7.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import Hyperswarm, { type NoiseSocket } from "hyperswarm";
import type { JsonValue } from "../bridge-protocol/wire.ts";

const MAX_LINE_BYTES = 1024 * 1024;

export function newInviteCode(): string {
  return randomBytes(16).toString("hex");
}

export function topicFor(inviteCode: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(inviteCode)) throw new Error("invite code must be 32 hex characters");
  return createHash("sha256").update("resolvecollab/v1/").update(inviteCode).digest();
}

// Events: "peer" (id), "peer-left" (id), "message" (message, fromId).
export class PeerLink extends EventEmitter {
  private readonly swarm = new Hyperswarm();
  private readonly sockets = new Map<string, NoiseSocket>();
  private readonly topic: Buffer;

  constructor(inviteCode: string) {
    super();
    this.topic = topicFor(inviteCode);
    this.swarm.on("connection", (socket) => this.accept(socket));
  }

  get id(): string {
    return this.swarm.keyPair.publicKey.toString("hex").slice(0, 8);
  }

  get peerCount(): number {
    return this.sockets.size;
  }

  async start(): Promise<void> {
    await this.swarm.join(this.topic, { server: true, client: true }).flushed();
  }

  async stop(): Promise<void> {
    await this.swarm.destroy();
  }

  send(message: JsonValue): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const socket of this.sockets.values()) socket.write(line);
  }

  private accept(socket: NoiseSocket): void {
    const id = socket.remotePublicKey.toString("hex").slice(0, 8);
    this.sockets.set(id, socket);
    this.emit("peer", id);
    let buffered = "";
    socket.on("data", (data: Buffer) => {
      buffered += data.toString("utf8");
      if (buffered.length > MAX_LINE_BYTES) {
        socket.destroy(new Error("message too large"));
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          this.emit("message", JSON.parse(line) as JsonValue, id);
        } catch {
          // A malformed line from a peer is dropped, not fatal.
        }
      }
    });
    const forget = () => {
      if (this.sockets.get(id) === socket) {
        this.sockets.delete(id);
        this.emit("peer-left", id);
      }
    };
    socket.on("close", forget);
    socket.on("error", forget);
  }
}
