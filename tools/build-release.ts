// Builds the Windows installer (SPEC §12.2): stages the app (sources, the
// runtime packages, Electron, ffmpeg) in dist\app and runs Inno Setup.
//   node tools/build-release.ts [--ffmpeg <folder with ffmpeg.exe and ffprobe.exe>]
// Default ffmpeg: the one this PC uses (findFfmpeg). shortcut: the LGPL build
// the spec asks for is used when given with --ffmpeg; downloading it is left
// to whoever builds (the proxy maker uses Windows' H.264 encoder with it).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findFfmpeg } from "../src/media/proxy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, "app");
const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const at = process.argv.indexOf("--ffmpeg");
const ffmpegDir = at > 0 ? process.argv[at + 1]! : dirname(findFfmpeg() ?? "");
if (!existsSync(join(ffmpegDir, "ffmpeg.exe")) || !existsSync(join(ffmpegDir, "ffprobe.exe"))) throw new Error(`no ffmpeg.exe and ffprobe.exe in ${ffmpegDir}: pass --ffmpeg <folder>`);
const iscc = join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe");
if (!existsSync(iscc)) throw new Error("Inno Setup 6 isn't installed: winget install JRSoftware.InnoSetup --scope user");

console.log(`Staging ResolveCollab ${version} in ${STAGE}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ["package.json", "package-lock.json", "launch.mjs"]) cpSync(join(ROOT, f), join(STAGE, f));
for (const d of ["bridge", "window"]) cpSync(join(ROOT, d), join(STAGE, d), { recursive: true });
cpSync(join(ROOT, "src"), join(STAGE, "src"), { recursive: true, filter: (p) => !p.endsWith(".test.ts") });
// The runtime packages only (npm's own list), Electron among them.
const packages = execFileSync("cmd.exe", ["/d", "/s", "/c", "npm ls --omit=dev --parseable --all"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/).filter((p) => p && p !== ROOT && relative(ROOT, p).startsWith("node_modules"));
for (const p of packages) cpSync(p, join(STAGE, relative(ROOT, p)), { recursive: true });
console.log(`  ${packages.length} runtime packages`);
// ffmpeg and its notices (an LGPL or GPL build's licence text, if it has one beside it).
mkdirSync(join(STAGE, "ffmpeg"));
for (const f of readdirSync(ffmpegDir)) if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(f)) cpSync(join(ffmpegDir, f), join(STAGE, "ffmpeg", f));
for (const lic of ["LICENSE", "LICENSE.txt", "COPYING.LGPLv2.1", "COPYING.GPLv3"]) {
  const p = join(ffmpegDir, "..", lic);
  if (existsSync(p)) cpSync(p, join(STAGE, "ffmpeg", lic));
}
console.log(`  ffmpeg from ${ffmpegDir}`);

execFileSync(iscc, [`/DAppVersion=${version}`, `/DSourceDir=${STAGE}`, `/DOutDir=${DIST}`, join(ROOT, "installer", "ResolveCollab.iss")], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`Installer: ${join(DIST, `ResolveCollab-Setup-${version}.exe`)}`);
