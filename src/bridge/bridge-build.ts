// Which bridge code Resolve is running. tools/install-bridge.ts stamps a hash
// of bridge/ResolveCollab.lua into the copy it installs; the bridge reports it
// in HELLO and every heartbeat; the companion compares it with the hash of the
// bridge file next to its own code. A mismatch means Resolve still runs an
// older (or newer) bridge, whose commands may not match.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_PLACEHOLDER = "__BUILD__";

export function bridgeBuild(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 12);
}

// The build of bridge/ResolveCollab.lua in this checkout.
export function localBridgeBuild(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "ResolveCollab.lua");
  return bridgeBuild(readFileSync(file, "utf8"));
}

export function buildWarning(expected: string, running: string | undefined): string | null {
  if (running === expected) return null;
  return "The ResolveCollab bridge running in Resolve isn't the one this companion has. "
    + "Start Workspace > Scripts > ResolveCollab again in Resolve (from the repo, run `node tools/install-bridge.ts` first).";
}
