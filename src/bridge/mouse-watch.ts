// Watches the pointer for two things, through one PowerShell child (Resolve's
// Lua can't call Windows):
// - whether the left button is held, so timeline sync waits while the user
//   drags something in Resolve (SPEC §20.5). A clip being dragged onto the
//   timeline is already a real item to scripts and has already overwritten what
//   lies under it; nothing in Resolve's API tells it apart.
// - where the pointer is and where Resolve's window is, while Resolve is the
//   window in front, for ghost cursors (SPEC §24.6).
// It reads the left button's state and the pointer's position, nothing else.

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CSHARP = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class RcPointer {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  public static void Run() {
    SetProcessDPIAware(); // physical pixels, like Resolve's own window
    string last = "";
    uint lastPid = 0; string name = "";
    IntPtr resolve = IntPtr.Zero; // Resolve's window, last seen in front
    while (true) {
      bool down = (GetAsyncKeyState(1) & 0x8000) != 0;
      POINT p; GetCursorPos(out p);
      IntPtr fg = GetForegroundWindow();
      uint pid; GetWindowThreadProcessId(fg, out pid);
      if (pid != lastPid) {
        lastPid = pid; name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
      }
      bool front = name == "resolve";
      if (front) resolve = fg;
      // While our own window is in front (typing in the chat), Resolve's
      // window still counts, so the others' cursors stay; ours isn't shared.
      // Our window is told apart by its process name: "resolvecollab" when
      // installed (SPEC §26.1), "electron" from the repo.
      bool ours = name == "resolvecollab" || name == "electron";
      IntPtr target = front ? fg : (ours && IsWindow(resolve) ? resolve : IntPtr.Zero);
      string win = "null";
      RECT r;
      // DWMWA_EXTENDED_FRAME_BOUNDS: the window as drawn, without its invisible borders.
      if (target != IntPtr.Zero && !IsIconic(target) && DwmGetWindowAttribute(target, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) {
        win = "[" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T) + "]";
      }
      string line = "{\\"d\\":" + (down ? 1 : 0) + ",\\"f\\":" + (front ? 1 : 0) + ",\\"p\\":[" + p.X + "," + p.Y + "],\\"w\\":" + win + "}";
      if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }
      Thread.Sleep(16); // about 60 times a second: ghost cursors move smoothly
    }
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
[RcPointer]::Run()
`;

export interface PointerState {
  down: boolean;
  pointer: [number, number]; // screen pixels
  front: boolean; // Resolve is the window in front
  resolve: [number, number, number, number] | null; // Resolve's window [left, top, width, height] while it or our window is in front
}

export class MouseWatch {
  private child: ChildProcess | undefined;
  private down = false;
  private readonly log: (message: string) => void;
  latest: PointerState | undefined;
  onChange: ((state: PointerState) => void) | undefined;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  get held(): boolean {
    return this.down;
  }

  start(): void {
    if (process.platform !== "win32") return;
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    let seen = false;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let raw: { d?: unknown; f?: unknown; p?: unknown; w?: unknown };
      try { raw = JSON.parse(line); } catch { return; }
      const nums = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x));
      if (!nums(raw.p, 2)) return;
      seen = true;
      this.down = raw.d === 1;
      this.latest = { down: this.down, front: raw.f === 1, pointer: raw.p as [number, number], resolve: nums(raw.w, 4) ? (raw.w as [number, number, number, number]) : null };
      this.onChange?.(this.latest);
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
