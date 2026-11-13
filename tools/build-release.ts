// Builds the Windows installer (SPEC §26.1): stages the app in dist\app and
// runs Inno Setup on installer\ResolveCollab.iss. Run with:
//   node tools/build-release.ts
// Needs: Inno Setup 6 (ISCC.exe), the LGPL ffmpeg in vendor\ffmpeg (step 5),
// and window\icon\icon.ico (tools/make-icon.mjs).
//
// dist\app holds: runtime\ (Electron, its exe renamed ResolveCollab.exe),
// src\ and window\ (no tests), bridge\ResolveCollab.lua, launch.mjs,
// package.json, the runtime packages in node_modules\, and ffmpeg\.

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const APP = join(DIST, "app");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

const ISCC = [join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"), "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe"].find(existsSync);
if (!ISCC) throw new Error("Inno Setup 6 isn't installed (winget install JRSoftware.InnoSetup)");
if (!existsSync(join(ROOT, "vendor", "ffmpeg", "ffmpeg.exe"))) throw new Error("the LGPL ffmpeg isn't in vendor\\ffmpeg");
if (!existsSync(join(ROOT, "window", "icon", "icon.ico"))) throw new Error("no window\\icon\\icon.ico: run tools/make-icon.mjs");

console.log(`staging ResolveCollab ${version} in ${APP} ...`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
const noTests = (src: string) => !/\.test\.ts$/.test(src);
cpSync(join(ROOT, "src"), join(APP, "src"), { recursive: true, filter: noTests });
cpSync(join(ROOT, "window"), join(APP, "window"), { recursive: true });
mkdirSync(join(APP, "bridge"));
cpSync(join(ROOT, "bridge", "ResolveCollab.lua"), join(APP, "bridge", "ResolveCollab.lua"));
for (const f of ["launch.mjs", "package.json"]) cpSync(join(ROOT, f), join(APP, f));
cpSync(join(ROOT, "vendor", "ffmpeg"), join(APP, "ffmpeg"), { recursive: true });

// Electron as the app's own runtime, its exe named after the app.
cpSync(join(ROOT, "node_modules", "electron", "dist"), join(APP, "runtime"), { recursive: true });
renameSync(join(APP, "runtime", "electron.exe"), join(APP, "runtime", "ResolveCollab.exe"));
// English only: the app's text is English, and Electron's 55 languages are 49 MB.
for (const f of readdirSync(join(APP, "runtime", "locales"))) if (f !== "en-US.pak") rmSync(join(APP, "runtime", "locales", f));

// Only the packages the app runs on (not Electron's npm wrapper, tests or tools).
const packages = execSync("npm ls --omit=dev --all --parseable", { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/).filter((p) => p && p !== ROOT && p.includes("node_modules"));
for (const p of packages) cpSync(p, join(APP, relative(ROOT, p)), { recursive: true });
console.log(`${packages.length} runtime packages`);

console.log("building the installer with Inno Setup ...");
execFileSync(ISCC, [
  `/DAppVersion=${version}`, `/DSourceDir=${APP}`, `/DOutDir=${DIST}`, `/DIconFile=${join(ROOT, "window", "icon", "icon.ico")}`,
  "/Q", join(ROOT, "installer", "ResolveCollab.iss"),
], { stdio: "inherit" });
console.log(`done: ${join(DIST, `ResolveCollab-Setup-${version}.exe`)}`);
