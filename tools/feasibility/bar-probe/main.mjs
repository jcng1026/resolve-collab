// Probe for SPEC §24.1 / §15 ("the overlay above a full-screen Resolve"): a
// frameless 360x150 bar at the bottom right, always on top of every window,
// with Windows 11's acrylic material. Prints what it sees, then quits.
//   npx electron tools/feasibility/bar-probe/main.mjs [seconds]
import { app, BrowserWindow, screen } from "electron";

const seconds = Number(process.argv.at(-1)) || 60;
const say = (m) => console.log(`${new Date().toISOString().slice(11, 23)}  ${m}`);

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: 360, height: 150, x: area.x + area.width - 360 - 16, y: area.y + area.height - 150 - 56,
    frame: false, resizable: false, skipTaskbar: true, show: false,
    backgroundMaterial: "acrylic", backgroundColor: "#00000000",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadURL("data:text/html," + encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px 'Segoe UI Variable Text','Segoe UI',sans-serif;color:#F5F5F7;background:rgba(30,30,32,0.55)">
    <div style="padding:12px"><b>ResolveCollab probe</b><br>Always on top, acrylic. Click Resolve: I should stay above it.</div></body>`));
  win.once("ready-to-show", () => { win.showInactive(); say(`shown at ${JSON.stringify(win.getBounds())}, on top: ${win.isAlwaysOnTop()}`); });
  win.on("blur", () => say("lost focus (another window in front); still on top: " + win.isAlwaysOnTop()));
  setTimeout(() => { say("done"); app.quit(); }, seconds * 1000);
});
