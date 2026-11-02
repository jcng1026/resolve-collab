// Minimal typings for the parts of hyperswarm 4.x and hyperdht that ResolveCollab uses.
declare module "hyperdht/testnet.js" {
  interface Testnet {
    bootstrap: { host: string; port: number }[];
    destroy(): Promise<void>;
  }
  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module "hyperswarm" {
  import type { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";

  export interface PeerInfo {
    publicKey: Buffer;
  }

  export interface NoiseSocket extends Duplex {
    remotePublicKey: Buffer;
  }

  export interface Discovery {
    flushed(): Promise<void>;
    refresh(options?: { server?: boolean; client?: boolean }): Promise<void>;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: Record<string, unknown>);
    keyPair: { publicKey: Buffer };
    join(topic: Buffer, options?: { server?: boolean; client?: boolean }): Discovery;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: "connection", listener: (socket: NoiseSocket, info: PeerInfo) => void): this;
  }
}
