// Prepares a feasibility run: generates test media with ffmpeg, writes the
// request files the Lua probe reads, and installs the probe scripts into
// Resolve's Scripts > Utility folder. Run with: node tools/feasibility/prepare.ts
// `--install-only` skips the media and request files and just (re)installs the probes.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toLuaLiteral } from "../../src/bridge-protocol/lua-literal.ts";
import { SCRIPTS_UTILITY, STATE_DIR, stampStateDir } from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(STATE_DIR, "media");

// winget doesn't always create a Links shim, so also look in its package folder.
function findFfmpeg(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const winget = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet");
  const link = join(winget, "Links", "ffmpeg.exe");
  if (existsSync(link)) return link;
  const packages = join(winget, "Packages");
  for (const pkg of existsSync(packages) ? readdirSync(packages) : []) {
    if (!pkg.startsWith("Gyan.FFmpeg")) continue;
    for (const build of readdirSync(join(packages, pkg))) {
      const exe = join(packages, pkg, build, "bin", "ffmpeg.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return "ffmpeg";
}

function ffmpeg(args: string[]): void {
  execFileSync(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

// 10 s, 24 fps, H.264 + AAC: a realistic stand-in for camera footage.
function testClip(out: string, video: string, toneHz: number, rate = 24): void {
  ffmpeg([
    "-f", "lavfi", "-i", `${video}=size=1920x1080:rate=${rate}:duration=10`,
    "-f", "lavfi", "-i", `sine=frequency=${toneHz}:sample_rate=48000:duration=10`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-c:a", "aac", "-shortest", out,
  ]);
}

const installOnly = process.argv.includes("--install-only");
if (!installOnly) {
  for (const dir of [MEDIA, join(MEDIA, "moved"), join(STATE_DIR, "out")]) mkdirSync(dir, { recursive: true });

  console.log(`Generating test media in ${MEDIA} ...`);
  testClip(join(MEDIA, "original.mp4"), "testsrc2", 440);
  testClip(join(MEDIA, "spare.mp4"), "smptehdbars", 660);
  testClip(join(MEDIA, "alt.mp4"), "rgbtestsrc", 880);
  testClip(join(MEDIA, "fps30.mp4"), "testsrc", 330, 30); // a frame rate other than the timeline's
  ffmpeg(["-i", join(MEDIA, "original.mp4"), "-vf", "scale=960:540", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", join(MEDIA, "proxy.mp4")]);
  copyFileSync(join(MEDIA, "spare.mp4"), join(MEDIA, "moved", "spare.mp4"));

  // The loop echoes request n back; collect.ts keeps rewriting this file.
  writeFileSync(join(STATE_DIR, "request.lua"), `return ${toLuaLiteral({ n: 0 })}\n`);
  // Harmless code: in an empty environment `tostring` is nil, so this must fail.
  writeFileSync(join(STATE_DIR, "attack.lua"), 'return {["leak"]=tostring(_G)}\n');
}

mkdirSync(SCRIPTS_UTILITY, { recursive: true });
for (const probe of ["ResolveCollab_Feasibility.lua", "ResolveCollab_MediaPoolProbe.lua", "ResolveCollab_TimelineProbe.lua", "ResolveCollab_TimelineAltProbe.lua"]) {
  const lua = readFileSync(join(HERE, probe), "utf8");
  writeFileSync(join(SCRIPTS_UTILITY, probe), stampStateDir(lua, STATE_DIR));
}
copyFileSync(join(HERE, "ResolveCollab_PythonProbe.py"), join(SCRIPTS_UTILITY, "ResolveCollab_PythonProbe.py"));

console.log(`Installed probe scripts into ${SCRIPTS_UTILITY}`);
console.log("Next: restart Resolve so it rescans the Scripts folder, then run collect.ts.");
