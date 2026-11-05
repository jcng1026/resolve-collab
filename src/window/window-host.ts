// Starts the companion window (SPEC §24) as an Electron child process and
// talks to it in JSON lines over a private named pipe: state out, actions in.
// (Electron's main process can't read stdin on Windows.) The pipe's name is
// random and given only to the window. If Electron can't start, the terminal
// keeps working on its own.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "window", "main.mjs");

// Events: "action" (an object with a string `type`, from the person), "closed".
export class CompanionWindow extends EventEmitter {
  private child: ChildProcess | undefined;
  private server: Server | undefined;
  private socket: Socket | undefined;
  private readonly prefsFile: string;
  private latest: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastOverlay = "";

  constructor(prefsFile: string) {
    super();
    this.prefsFile = prefsFile;
  }

  get open(): boolean {
    return this.child !== undefined;
  }

  start(): boolean {
    let exe: string;
    try {
      exe = createRequire(import.meta.url)("electron") as string; // the electron package's binary path
    } catch {
      return false;
    }
    const pipe = `\\\\.\\pipe\\resolvecollab-${randomBytes(16).toString("hex")}`;
    const server = createServer((socket) => {
      if (this.socket) return void socket.destroy(); // the window, once
      this.socket = socket;
      socket.on("error", () => {});
      createInterface({ input: socket }).on("line", (line) => {
        try {
          const action = JSON.parse(line) as { type?: unknown };
          if (action && typeof action === "object" && typeof action.type === "string") this.emit("action", action);
        } catch { /* a broken line is skipped */ }
      });
      this.flush();
    });
    server.on("error", () => {});
    server.listen(pipe);
    this.server = server;
    const env: NodeJS.ProcessEnv = { ...process.env, RC_WINDOW_PREFS: this.prefsFile, RC_PIPE: pipe };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [MAIN], { stdio: "ignore", env });
    this.child = child;
    child.on("error", () => {});
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.server?.close();
      this.emit("closed");
    });
    return true;
  }

  // The state to show; sent at most every 50 ms, the newest winning.
  show(state: object): void {
    this.latest = JSON.stringify(state);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }

  // The others' cursors over Resolve (SPEC §24.6), or null to hide them. Sent
  // straight away (they move), and only when something changed.
  overlay(o: { rect: number[]; cursors: object[] } | null): void {
    const line = JSON.stringify({ $overlay: o });
    if (line === this.lastOverlay) return;
    this.lastOverlay = line;
    if (this.socket && !this.socket.destroyed) this.socket.write(`${line}\n`);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.latest !== undefined && this.socket && !this.socket.destroyed) this.socket.write(`${this.latest}\n`);
  }

  stop(): void {
    clearTimeout(this.timer);
    const child = this.child;
    this.child = undefined;
    this.socket?.end(); // the window quits when the pipe closes
    this.server?.close();
    setTimeout(() => child?.kill(), 1500).unref();
  }
}
