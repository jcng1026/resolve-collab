// This app's version (package.json), shown and compared between PCs (SPEC §12.2).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_VERSION: string = (() => {
  try {
    return String((JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();
