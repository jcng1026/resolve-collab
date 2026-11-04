// Claims Ctrl+Z (undo) and Ctrl+Shift+Z (redo) while Resolve is the window in
// front and the companion allows it (Media, Cut or Edit page), so they undo
// only this person's own synced changes (SPEC §23.2). It uses Windows' hotkey
// registration (RegisterHotKey): Windows tells it about those two shortcuts
// only, and no other keys are read. Resolve's Lua can't call Windows, so a
// PowerShell child does it, like the mouse watch.
//
// The child prints: "armed" / "released" (claimed or given back), "undo" /
// "redo" (pressed), "taken" (another program already claimed them). It reads
// "on" / "off" lines (whether the page allows it) and exits when its input
// closes, so it never outlives the companion.

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const CSHARP = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class UndoKeys {
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  static volatile bool allowed = false;
  static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
  public static void Run(string target) {
    Thread reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "on") allowed = true; else if (line == "off") allowed = false;
      }
      Environment.Exit(0);
    });
    reader.IsBackground = true;
    reader.Start();
    bool armed = false, inFront = false, taken = false;
    uint lastPid = 0;
    while (true) {
      MSG msg;
      while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {
        if (msg.message == 0x0312) Say(msg.wParam.ToInt32() == 1 ? "undo" : "redo");
      }
      uint pid;
      GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      if (pid != lastPid) {
        lastPid = pid;
        inFront = false;
        try { inFront = Process.GetProcessById((int)pid).ProcessName.Equals(target, StringComparison.OrdinalIgnoreCase); } catch { }
      }
      bool want = allowed && inFront && !taken;
      if (want && !armed) {
        // MOD_NOREPEAT | MOD_CONTROL (| MOD_SHIFT), the Z key.
        if (RegisterHotKey(IntPtr.Zero, 1, 0x4002, 0x5A) && RegisterHotKey(IntPtr.Zero, 2, 0x4006, 0x5A)) {
          armed = true;
          Say("armed");
        } else {
          UnregisterHotKey(IntPtr.Zero, 1);
          UnregisterHotKey(IntPtr.Zero, 2);
          taken = true;
          Say("taken");
        }
      } else if (!want && armed) {
        UnregisterHotKey(IntPtr.Zero, 1);
        UnregisterHotKey(IntPtr.Zero, 2);
        armed = false;
        Say("released");
      }
      Thread.Sleep(30);
    }
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
[UndoKeys]::Run('Resolve')
`;

// Events: "undo", "redo", "armed", "released", "taken", "gone" (the child stopped).
export class UndoKeys extends EventEmitter {
  private child: ChildProcess | undefined;
  private allowed = false;

  start(): void {
    if (process.platform !== "win32" || this.child) return;
    // stdin carries only the "on" / "off" lines, so the script goes on the
    // command line (PowerShell's -EncodedCommand is UTF-16LE base64).
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdin!.write(this.allowed ? "on\n" : "off\n");
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const event = line.trim();
      if (["undo", "redo", "armed", "released", "taken"].includes(event)) this.emit(event);
    });
    let problem = "";
    child.stderr!.on("data", (d: Buffer) => { problem = (problem + d.toString()).slice(-2000); });
    child.stdin!.on("error", () => {});
    child.on("error", () => {});
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.emit("gone", problem.trim());
    });
  }

  // Whether Resolve's page is one where the companion's undo applies.
  allow(allowed: boolean): void {
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    this.child?.stdin?.write(allowed ? "on\n" : "off\n");
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin?.end();
    child?.kill();
  }
}
