// Peer-to-peer link between companions (SPEC §3.1, §18.3): Hyperswarm finds
// peers on a topic derived from the invite secret; connections are
// Noise-encrypted. Messages are newline-delimited JSON.
//
// Hyperswarm often opens a duplicate connection and closes one of the pair a
// moment later; anything written to the closed one is lost. So every message
// is numbered, acknowledged by the receiver, and resent until acknowledged;
// the receiver drops duplicates.
//
// Anyone who knows the secret can connect; ordering is done above this link
// by the host (SPEC §19.3). Host approval arrives in M6, locks in M7.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import Hyperswarm, { type Discovery, type NoiseSocket } from "hyperswarm";
import type { JsonValue } from "../bridge-protocol/wire.ts";

const MAX_LINE_BYTES = 1024 * 1024;
// Peers that join at the same moment each look up the topic before the other
// has announced, and Hyperswarm's own refresh can take minutes. While alone,
// look again this often.
const LONELY_REFRESH_MS = 3000;
const RESEND_MS = 500;
// Unacknowledged messages, and messages sent while no peer is connected,
// are dropped after this long so a late joiner doesn't get stale edits.
const EXPIRE_MS = 10_000;
const SEEN_MAX = 10_000;

export function newInviteCode(): string {
  return randomBytes(16).toString("hex");
}

export function topicFor(inviteCode: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(inviteCode)) throw new Error("invite code must be 32 hex characters");
  return createHash("sha256").update("resolvecollab/v1/").update(inviteCode).digest();
}

export interface PeerLinkOptions {
  // DHT bootstrap nodes; defaults to the public Hyperswarm network. Tests
  // pass a local testnet, since public discovery takes ~10–60 s.
  bootstrap?: { host: string; port: number }[];
}

interface Outgoing {
  line: string;
  at: number;
}

interface Peer {
  // Every open socket, newest last.
  sockets: NoiseSocket[];
  outstanding: Map<number, Outgoing>;
  seen: Set<number>;
}

// Events: "peer" (id), "peer-left" (id), "message" (message, fromId).
export class PeerLink extends EventEmitter {
  private readonly swarm: Hyperswarm;
  private readonly peers = new Map<string, Peer>();
  private readonly topic: Buffer;
  private discovery: Discovery | undefined;
  private timers: NodeJS.Timeout[] = [];
  private nextId = 1;
  private held: (Outgoing & { id: number })[] = [];

  constructor(inviteCode: string, options: PeerLinkOptions = {}) {
    super();
    this.topic = topicFor(inviteCode);
    this.swarm = new Hyperswarm(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    this.swarm.on("connection", (socket) => this.accept(socket));
  }

  get id(): string {
    return this.swarm.keyPair.publicKey.toString("hex").slice(0, 8);
  }

  get peerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.sockets.length > 0) count++;
    return count;
  }

  async start(): Promise<void> {
    this.discovery = this.swarm.join(this.topic, { server: true, client: true });
    await this.discovery.flushed();
    this.timers.push(
      setInterval(() => {
        if (this.peerCount === 0) this.discovery?.refresh({ server: true, client: true }).catch(() => {});
      }, LONELY_REFRESH_MS),
      setInterval(() => this.resend(), RESEND_MS),
    );
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    for (const peer of this.peers.values()) for (const socket of peer.sockets) socket.on("error", () => {});
    await this.swarm.destroy();
  }

  send(message: JsonValue): void {
    const id = this.nextId++;
    const outgoing = { line: `${JSON.stringify({ m: id, d: message })}\n`, at: Date.now() };
    let queued = false;
    for (const peer of this.peers.values()) {
      if (peer.sockets.length === 0) continue;
      peer.outstanding.set(id, outgoing);
      this.write(peer, outgoing.line);
      queued = true;
    }
    if (!queued) this.held.push({ id, ...outgoing });
  }

  // To one peer only; dropped if it isn't connected (the session resyncs
  // whoever reconnects).
  sendTo(peerId: string, message: JsonValue): boolean {
    const peer = this.peers.get(peerId);
    if (!peer || peer.sockets.length === 0) return false;
    const id = this.nextId++;
    const outgoing = { line: `${JSON.stringify({ m: id, d: message })}\n`, at: Date.now() };
    peer.outstanding.set(id, outgoing);
    this.write(peer, outgoing.line);
    return true;
  }

  private write(peer: Peer, line: string): void {
    peer.sockets.findLast((socket) => !socket.destroyed && socket.writable)?.write(line);
  }

  private resend(): void {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      for (const [id, outgoing] of peer.outstanding) {
        if (now - outgoing.at > EXPIRE_MS) peer.outstanding.delete(id);
        else this.write(peer, outgoing.line);
      }
    }
    this.held = this.held.filter((h) => now - h.at <= EXPIRE_MS);
  }

  private accept(socket: NoiseSocket): void {
    const id = socket.remotePublicKey.toString("hex").slice(0, 8);
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { sockets: [], outstanding: new Map(), seen: new Set() };
      this.peers.set(id, peer);
    }
    peer.sockets.push(socket);
    if (peer.sockets.length === 1) {
      this.emit("peer", id);
      for (const h of this.held) peer.outstanding.set(h.id, h);
      this.held = [];
    }
    for (const outgoing of peer.outstanding.values()) socket.write(outgoing.line);

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
        if (line) this.receive(peer, id, socket, line);
      }
    });
    const forget = () => {
      peer.sockets = peer.sockets.filter((s) => s !== socket);
      if (peer.sockets.length === 0) this.emit("peer-left", id);
    };
    socket.on("close", forget);
    socket.on("error", forget);
  }

  private receive(peer: Peer, id: string, socket: NoiseSocket, line: string): void {
    let frame: { m?: unknown; a?: unknown; d?: JsonValue };
    try {
      frame = JSON.parse(line);
    } catch {
      return; // a malformed line from a peer is dropped, not fatal
    }
    if (typeof frame.a === "number") {
      peer.outstanding.delete(frame.a);
      return;
    }
    if (typeof frame.m !== "number") return;
    if (!socket.destroyed) socket.write(`${JSON.stringify({ a: frame.m })}\n`);
    if (peer.seen.has(frame.m)) return;
    peer.seen.add(frame.m);
    if (peer.seen.size > SEEN_MAX) peer.seen.delete(peer.seen.values().next().value!);
    this.emit("message", frame.d ?? null, id);
  }
}
