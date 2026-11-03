// Watches whether the left mouse button is held down, so timeline sync can
// wait while the user drags something in Resolve (SPEC §20.5).
//
// A clip being dragged onto the timeline is already a real item to scripts,
// with the ID it keeps after the drop, and it has already overwritten what
// lies under it. Nothing in Resolve's API tells it apart, and editing the
// timeline around it crashed Resolve. Resolve's Lua can't call Windows, so the
// companion reads the button state (only that button) through PowerShell.

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace RC -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);'
$last = ''
while ($true) {
  $down = if (([RC.Mouse]::GetAsyncKeyState(1) -band 0x8000) -ne 0) { '1' } else { '0' }
  if ($down -ne $last) { [Console]::Out.WriteLine($down); [Console]::Out.Flush(); $last = $down }
  Start-Sleep -Milliseconds 50
}
`;

export class MouseWatch {
  private child: ChildProcess | undefined;
  private down = false;
  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  get held(): boolean {
    return this.down;
  }

  start(): void {
    if (process.platform !== "win32") return;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    let seen = false;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      seen = true;
      this.down = line.trim() === "1";
    });
    child.on("error", () => {});
    child.on("exit", () => {
      this.down = false;
      if (this.child !== child) return;
      this.child = undefined;
      this.log(seen
        ? "stopped watching the mouse; timeline sync now only waits 1 s after your edits"
        : "can't watch the mouse here; timeline sync only waits 1 s after your edits, so finish a drag within a second");
    });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
