// The companion window (SPEC §24): a small always-on-top chat bar that grows
// into a tall strip. Electron only draws it. The companion, a separate Node
// process, talks to it in JSON lines over a private named pipe it names in
// RC_PIPE (Electron's main process can't read stdin on Windows). Nothing from
// other PCs runs here: the page shows text it's given.

import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, screen, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The Media grid's thumbnails: rcthumb://t/<clip fingerprint>, served only
// from the companion's thumbnail folder, only for a 64-hex name.
const THUMBS = process.env.RC_THUMBS ?? "";
protocol.registerSchemesAsPrivileged([{ scheme: "rcthumb", privileges: { standard: true, secure: true } }]);
function serveThumbs() {
  protocol.handle("rcthumb", (request) => {
    const name = new URL(request.url).pathname.slice(1);
    if (!THUMBS || !/^[0-9a-f]{64}$/.test(name)) return new Response("", { status: 404 });
    return net.fetch(pathToFileURL(join(THUMBS, `${name}.jpg`)).toString());
  });
}
const PREFS = process.env.RC_WINDOW_PREFS ?? join(app.getPath("userData"), "window.json");
const WIDTH = 360;
const MARGIN = 16; // from the screen's right edge
const BOTTOM_GAP = 56; // above Resolve's Project Manager and Settings buttons

let prefs = {};
try { prefs = JSON.parse(readFileSync(PREFS, "utf8")); } catch { prefs = {}; }
const savePrefs = () => {
  try {
    mkdirSync(dirname(PREFS), { recursive: true });
    writeFileSync(PREFS, JSON.stringify(prefs));
  } catch { /* a read-only profile: the window just forgets */ }
};
const pipe = connect(process.env.RC_PIPE ?? "");
pipe.on("error", () => app.quit());
const out = (message) => { if (!pipe.destroyed) pipe.write(`${JSON.stringify(message)}\n`); };

// Ghost cursors (SPEC §24.6) default on; the companion needs to know the choices.
const cursorPrefs = () => ({ showCursors: prefs.showCursors !== false, shareCursor: prefs.shareCursor !== false });
out({ type: "cursor-prefs", ...cursorPrefs() });

let win;
let expanded = false;
let contentHeight = 150;
let placing = false;

// The window grows away from the nearer top or bottom edge (SPEC §24.1): an
// anchor is the edge it keeps still, "up" = its bottom edge, "down" = its top.
function area() {
  const at = { x: Math.round(prefs.x ?? 0), y: Math.round(prefs.anchorY ?? 0) };
  return (prefs.x === undefined ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(at)).workArea;
}
// `smooth`: grown or shrunk over 0.18 s, eased, the anchored edge kept still
// (expanding and collapsing are seamless). Otherwise at once.
const GROW_MS = 180;
let fading;
let growing;
function place(smooth = false) {
  const a = area();
  if (prefs.x === undefined) Object.assign(prefs, { x: a.x + a.width - WIDTH - MARGIN, anchorY: a.y + a.height - BOTTOM_GAP, dir: "up" });
  const max = Math.round(a.height * 0.8);
  const height = Math.min(max, expanded ? max : Math.max(60, Math.ceil(contentHeight)));
  const x = Math.min(Math.max(prefs.x, a.x), a.x + a.width - WIDTH);
  const y = prefs.dir === "down" ? Math.max(prefs.anchorY, a.y) : Math.min(prefs.anchorY, a.y + a.height) - height;
  const target = { x, y: Math.max(a.y, y), width: WIDTH, height };
  win.webContents.send("layout", { dir: prefs.dir, expanded });
  clearInterval(growing);
  if (!smooth) {
    placing = true;
    win.setBounds(target);
    placing = false;
    return;
  }
  const from = win.getBounds();
  const start = Date.now();
  placing = true;
  growing = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / GROW_MS);
    const e = 1 - (1 - t) ** 3;
    const at = (p, q) => Math.round(p + (q - p) * e);
    win.setBounds({ x: target.x, y: at(from.y, target.y), width: WIDTH, height: at(from.height, target.height) });
    if (t >= 1) {
      clearInterval(growing);
      placing = false;
      if (!expanded) place(); // the bar's height may have changed meanwhile
    }
  }, 1000 / 60);
}

// After the person drags it: remember where, and which way it now opens.
function moved() {
  if (placing) return;
  const b = win.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const lower = b.y + b.height / 2 > a.y + a.height / 2;
  Object.assign(prefs, { x: b.x, dir: lower ? "up" : "down", anchorY: lower ? b.y + b.height : b.y });
  savePrefs();
  place();
}

// The others' cursors: a see-through window exactly over Resolve's that never
// takes a click or the focus, under the bar. `rect` is in screen pixels.
let overlay;
let overlayLoaded = false;
let overlayCursors = [];
function showOverlay(o) {
  if (!o || !Array.isArray(o.rect) || o.rect.length !== 4) return void overlay?.hide();
  if (!overlay) {
    overlay = new BrowserWindow({
      show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false,
      focusable: false, skipTaskbar: true, maximizable: false, minimizable: false, fullscreenable: false, title: "ResolveCollab cursors",
      // It never has the focus; it still animates at full rate.
      webPreferences: { preload: join(HERE, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    overlay.setIgnoreMouseEvents(true);
    // Left out of screen captures, so reading Resolve's ruler never reads
    // the cursors back (SPEC §24.6.1); also out of screen recordings.
    if (!process.env.RC_OVERLAY_CAPTURE) overlay.setContentProtection(true); // the probe's screenshots need it
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.webContents.on("will-navigate", (e) => e.preventDefault());
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("did-finish-load", () => { overlayLoaded = true; overlay.webContents.send("cursors", overlayCursors); });
    overlay.loadFile(join(HERE, "overlay.html"));
  }
  const [x, y, width, height] = o.rect.map(Math.round);
  const dip = screen.screenToDipRect(null, { x, y, width, height });
  const b = overlay.getBounds();
  if (b.x !== dip.x || b.y !== dip.y || b.width !== dip.width || b.height !== dip.height) overlay.setBounds(dip);
  overlayCursors = Array.isArray(o.cursors) ? o.cursors : [];
  if (overlayLoaded) overlay.webContents.send("cursors", overlayCursors);
  if (!overlay.isVisible()) {
    overlay.showInactive();
    win?.moveTop(); // the bar stays above the cursors
  }
}

app.whenReady().then(() => {
  serveThumbs();
  win = new BrowserWindow({
    width: WIDTH, height: contentHeight, show: false, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    title: "ResolveCollab", icon: join(HERE, "icon", "icon.ico"), backgroundMaterial: "acrylic", backgroundColor: "#00000000",
    webPreferences: { preload: join(HERE, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  // Always on top of every window, by the user's choice (SPEC §24.1).
  win.setAlwaysOnTop(true, "screen-saver");
  // The page never leaves its own file or opens other windows.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("moved", moved);
  // The page's errors go to the companion's log, to be seen.
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") out({ type: "window-log", text: `${e.message} (${e.sourceId}:${e.lineNumber})`.slice(0, 500) });
  });
  win.webContents.on("preload-error", (_e, path, error) => out({ type: "window-log", text: `preload ${path}: ${String(error)}`.slice(0, 500) }));
  win.loadFile(join(HERE, "index.html"));
  win.once("ready-to-show", () => {
    place();
    win.webContents.send("prefs", { closeChoice: prefs.closeChoice ?? "", sound: prefs.sound === true, ...cursorPrefs() });
    win.showInactive();
    // Started from something minimised or hidden, Windows can open it minimised: it never should.
    if (win.isMinimized()) win.restore();
  });

  // From the page.
  ipcMain.on("rc", (_e, message) => {
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "size":
        if (Number.isFinite(message.height)) contentHeight = message.height;
        if (!expanded && !placing) place(); // while growing, the end settles it
        return;
      case "expand":
        expanded = message.on === true;
        place(true);
        return;
      case "dim": { // quieter when idle: the whole window to 60%, over 0.2 s
        const to = message.on === true ? 0.6 : 1;
        const from = win.getOpacity();
        const start = Date.now();
        clearInterval(fading);
        fading = setInterval(() => {
          const t = Math.min(1, (Date.now() - start) / 200);
          win.setOpacity(from + (to - from) * t);
          if (t >= 1) clearInterval(fading);
        }, 1000 / 60);
        return;
      }
      case "copy":
        if (typeof message.text === "string") clipboard.writeText(message.text.slice(0, 200));
        return;
      case "prefs":
        if (typeof message.closeChoice === "string") prefs.closeChoice = message.closeChoice;
        if (typeof message.sound === "boolean") prefs.sound = message.sound;
        if (typeof message.showCursors === "boolean") prefs.showCursors = message.showCursors;
        if (typeof message.shareCursor === "boolean") prefs.shareCursor = message.shareCursor;
        savePrefs();
        out({ type: "cursor-prefs", ...cursorPrefs() });
        return;
      case "pick-file":
        void dialog.showOpenDialog(win, { title: `Locate ${String(message.name ?? "the clip")}`, properties: ["openFile"] }).then((r) => {
          if (!r.canceled && r.filePaths[0]) out({ type: "locate", clip: String(message.clip), path: r.filePaths[0] });
        });
        return;
      case "pick-folder": // where downloaded media goes (SPEC §25.1)
        void dialog.showOpenDialog(win, { title: "Where should downloaded media go?", properties: ["openDirectory", "createDirectory"] }).then((r) => {
          if (!r.canceled && r.filePaths[0]) out({ type: "media-folder", path: r.filePaths[0] });
        });
        return;
      case "open-folder": // the media folder, in Explorer; never a file
        if (typeof message.path === "string") {
          try {
            if (!existsSync(message.path)) mkdirSync(message.path, { recursive: true });
            if (statSync(message.path).isDirectory()) void shell.openPath(message.path);
          } catch { /* a bad path: nothing opens */ }
        }
        return;
      default:
        out(message); // everything else is for the companion
    }
  });

  // From the companion: the state to show. The pipe closing means it quit.
  // The newest is kept for the page: states sent before it has loaded are lost.
  let latest;
  let loaded = false;
  win.webContents.on("did-finish-load", () => {
    loaded = true;
    if (latest) win.webContents.send("state", latest);
  });
  const input = createInterface({ input: pipe });
  input.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message && "$overlay" in message) return void showOverlay(message.$overlay);
      if (message && message.$show === true) { // started again: come forward
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return;
      }
      latest = message;
      if (loaded) win.webContents.send("state", latest);
    } catch { /* a broken line is skipped */ }
  });
  input.on("close", () => app.quit());
});
