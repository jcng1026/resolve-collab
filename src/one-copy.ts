// One companion per Windows user (SPEC §26.1): two would both talk to
// Resolve's bridge. The first one listens on a named pipe; a later one finds
// it there, asks it to bring its window forward, and stops.

import { createHash } from "node:crypto";
import { type Server, connect, createServer } from "node:net";
import { userInfo } from "node:os";

const PIPE = `\\\\.\\pipe\\resolvecollab-app-${createHash("sha256").update(userInfo().username).digest("hex").slice(0, 16)}`;

// Resolves with the server if this is the only companion, or undefined once
// the running one has been asked to show itself.
export async function claimOneCopy(onShow: () => void): Promise<Server | undefined> {
  const asked = await new Promise<boolean>((resolve) => {
    const socket = connect(PIPE, () => socket.end("show\n", () => resolve(true)));
    socket.on("error", () => resolve(false));
  });
  if (asked) return undefined;
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => { if (data.toString().includes("show")) onShow(); });
    });
    server.on("error", reject);
    server.listen(PIPE, () => resolve(server));
  });
}
