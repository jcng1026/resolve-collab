// Where downloaded media goes (SPEC §10.5, §25.3): inside the project's media
// folder, in sub-folders named after the media pool's bins. Every name here
// can come from another PC, so each is cleaned, and the final path is checked
// to be inside the folder.

import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// One folder or file name, safe on Windows: no separators or characters
// Windows refuses, no "." or "..", no reserved device names, no trailing dot
// or space, at most 120 characters. Empty input gives `fallback`.
export function cleanName(name: string, fallback = "media"): string {
  let s = name.normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim().replace(/[. ]+$/, "");
  if (s.length > 120) {
    const ext = extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length).replace(/[. ]+$/, "") + ext;
  }
  if (!s || s === "." || s === "..") s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

// The project's default media folder: Videos\ResolveCollab\<Project>.
export function defaultMediaFolder(project: string): string {
  return join(homedir(), "Videos", "ResolveCollab", cleanName(project, "Project"));
}

// Where a clip's file goes: <folder>\<bins…>\<file>; a proxy is "<name> (proxy).mp4".
// Throws if the result would leave the folder (it can't, after cleaning: this is the backstop).
export function mediaPath(folder: string, bins: string[], fileName: string, kind: "proxy" | "original"): string {
  const file = cleanName(fileName);
  const stem = extname(file) ? file.slice(0, -extname(file).length) : file;
  const name = kind === "proxy" ? `${cleanName(stem)} (proxy).mp4` : file;
  const path = resolve(folder, ...bins.slice(0, 20).map((b) => cleanName(b, "Bin")), name);
  if (!inside(folder, path)) throw new Error(`refusing a path outside the media folder: ${path}`);
  return path;
}

export function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith(sep);
}
