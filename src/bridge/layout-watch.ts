// Reads where Resolve's panels are and what its timeline's ruler and track
// names say (SPEC §24.6.1), through one PowerShell child: Windows' UI
// Automation for the panels, a capture of only the timeline's ruler strip and
// track-name column, and Windows' built-in text recognition (OCR) on them,
// only when those pixels changed. Only while Resolve (or our window) is in
// front, about twice a second. The images never leave this PC.

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PANELS, type Panel, type Rect, type Text } from "../layout.ts";

const CSHARP = `
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class RcShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static uint ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
  static Bitmap last;
  // The screen at x, y, w, h; returns a checksum of its pixels and keeps it.
  public static long Shot(int x, int y, int w, int h) {
    if (last != null) last.Dispose();
    last = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(last)) g.CopyFromScreen(x, y, 0, 0, last.Size);
    var d = last.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * h];
    Marshal.Copy(d.Scan0, px, 0, px.Length);
    last.UnlockBits(d);
    long sum = 1469598103934665603;
    for (int i = 0; i < px.Length; i++) sum = (sum ^ px[i]) * 1099511628211;
    return sum;
  }
  // The kept capture, k times larger (small text reads better), as BGRA bytes.
  public static byte[] Big(int k, out int bw, out int bh) {
    bw = last.Width * k; bh = last.Height * k;
    using (var big = new Bitmap(bw, bh, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(big)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(last, 0, 0, bw, bh); }
      var d = big.LockBits(new Rectangle(0, 0, bw, bh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var px = new byte[d.Stride * bh];
      Marshal.Copy(d.Scan0, px, 0, px.Length);
      big.UnlockBits(d);
      return px;
    }
  }
}
`;

// Class names of Resolve 21's panels, read with UI Automation (SPEC §24.6.1).
const CLASSES: Record<string, Panel> = {
  UiMediaPoolMultipleViewsImp: "mediapool",
  UiEditToolboxContainerImp: "toolbox",
  UiPlayerWidgetImp: "viewer",
  UiInspectorWidgetImp: "inspector",
  UiTiSequenceView: "timeline",
};

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Runtime.WindowsRuntime
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${CSHARP}
'@
[RcShot]::SetProcessDPIAware() | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

# What the OCR reads in the kept capture at (x, y), as words or as lines.
function ReadText($x, $y, $k, $lines) {
  $bw = 0; $bh = 0
  $px = [RcShot]::Big($k, [ref]$bw, [ref]$bh)
  $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($px)
  $sb = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $bw, $bh)
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $out = New-Object System.Collections.ArrayList
  foreach ($line in $res.Lines) {
    $ws = @($line.Words)
    if ($ws.Count -eq 0) { continue }
    if ($lines) {
      $a = $ws[0].BoundingRect; $z = $ws[$ws.Count - 1].BoundingRect
      [void]$out.Add(@{ t = $line.Text; x = $x + $a.X / $k; y = $y + $a.Y / $k; w = ($z.X + $z.Width - $a.X) / $k; h = $a.Height / $k })
    } else {
      foreach ($wd in $ws) { $b = $wd.BoundingRect; [void]$out.Add(@{ t = $wd.Text; x = $x + $b.X / $k; y = $y + $b.Y / $k; w = $b.Width / $k; h = $b.Height / $k }) }
    }
  }
  ,$out.ToArray()
}

$classes = @{ ${Object.entries(CLASSES).map(([c, p]) => `'${c}' = '${p}'`).join("; ")} }
$conds = [System.Windows.Automation.Condition[]]@($classes.Keys | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $_) })
$any = New-Object System.Windows.Automation.OrCondition(,$conds)
$hwnd = [IntPtr]::Zero; $root = $null; $found = @{}; $lastFind = [DateTime]::MinValue
$lastPid = 0; $name = ''; $rulerSum = 0; $headSum = 0; $ruler = @(); $heads = @(); $lastLine = ''
while ($true) {
  Start-Sleep -Milliseconds 400
  try {
    $fg = [RcShot]::ForegroundPid()
    if ($fg -ne $lastPid) { $lastPid = $fg; $name = ''; try { $name = (Get-Process -Id $fg).ProcessName.ToLowerInvariant() } catch { } }
    if ($name -ne 'resolve' -and $name -ne 'electron') { continue }
    if ($root -eq $null) {
      $p = Get-Process Resolve -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
      if (-not $p) { continue }
      $hwnd = $p.MainWindowHandle; $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd); $found = @{}; $lastFind = [DateTime]::MinValue
    }
    if ([RcShot]::IsIconic($hwnd)) { continue }
    # The panels are looked up again every 3 s (pages and layouts change them).
    if (([DateTime]::Now - $lastFind).TotalSeconds -gt 3) {
      $lastFind = [DateTime]::Now; $found = @{}
      foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $any)) {
        $c = $el.Current
        $k = $classes[$c.ClassName]
        if ($k -and -not $found.ContainsKey($k) -and -not $c.IsOffscreen -and $c.BoundingRectangle.Width -gt 0) { $found[$k] = $el }
      }
    }
    $panels = @{}
    foreach ($k in @($found.Keys)) {
      try {
        $c = $found[$k].Current; $r = $c.BoundingRectangle
        if (-not $c.IsOffscreen -and $r.Width -gt 0) { $panels[$k] = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) }
      } catch { $found.Remove($k) }
    }
    $scale = [RcShot]::GetDpiForWindow($hwnd) / 96.0
    $tl = $panels['timeline']
    if ($tl) {
      $rh = [int](26 * $scale)
      $s = [RcShot]::Shot($tl[0], $tl[1], $tl[2], $rh)
      if ($s -ne $rulerSum) { $rulerSum = $s; $ruler = ReadText $tl[0] $tl[1] 3 $false }
      $hw = [Math]::Min([int](260 * $scale), $tl[2]); $hh = $tl[3] - $rh
      if ($hh -gt 0) {
        $s = [RcShot]::Shot($tl[0], $tl[1] + $rh, $hw, $hh)
        if ($s -ne $headSum) { $headSum = $s; $heads = ReadText $tl[0] ($tl[1] + $rh) 2 $true }
      }
    } else { $ruler = @(); $heads = @(); $rulerSum = 0; $headSum = 0 }
    $line = ConvertTo-Json -Compress -Depth 4 @{ panels = $panels; ruler = @($ruler); heads = @($heads); scale = $scale }
    if ($line -ne $lastLine) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $lastLine = $line }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $root = $null # Resolve restarted, or its window went: find it again
  }
}
`;

export interface ResolveLayout {
  panels: Partial<Record<Panel, Rect>>;
  ruler: Text[];
  heads: Text[];
  scale: number;
}

const rect = (v: unknown): v is Rect => Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));
const texts = (v: unknown): Text[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((o: { t?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }) =>
    o && typeof o.t === "string" && [o.x, o.y, o.w, o.h].every((n) => Number.isFinite(n))
      ? [{ text: o.t.slice(0, 100), x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number }]
      : []);

export class LayoutWatch {
  private child: ChildProcess | undefined;
  private readonly log: (message: string) => void;
  latest: ResolveLayout | undefined;
  onChange: ((layout: ResolveLayout) => void) | undefined;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  start(): void {
    if (process.platform !== "win32" || this.child) return;
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    let errors = 0;
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.startsWith("#< CLIXML") || line.startsWith("<Objs")) return; // PowerShell's own noise
      if (errors++ < 3) this.log(`layout watch: ${line.slice(0, 200)}`);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let raw: { panels?: Record<string, unknown>; ruler?: unknown; heads?: unknown; scale?: unknown };
      try { raw = JSON.parse(line); } catch { return; }
      const panels: Partial<Record<Panel, Rect>> = {};
      for (const p of PANELS) if (rect(raw.panels?.[p])) panels[p] = raw.panels[p] as Rect;
      const scale = typeof raw.scale === "number" && raw.scale > 0 && raw.scale < 8 ? raw.scale : 1;
      this.latest = { panels, ruler: texts(raw.ruler), heads: texts(raw.heads), scale };
      this.onChange?.(this.latest);
    });
    child.on("error", () => {});
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.latest = undefined;
      this.log("stopped reading Resolve's layout; ghost cursors use the whole window");
    });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.latest = undefined;
    child?.kill();
  }
}
