// Builds window/icon/icon.ico (and icon-256.png) from window/icon/icon.svg
// (48 px and up) and icon-small.svg (16–32 px), rendered by Electron. The
// .ico holds one PNG per size, as Windows has allowed since Vista. Run with:
//   node_modules\electron\dist\electron.exe tools/make-icon.mjs

import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "window", "icon");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Each size drawn on a canvas in one hidden page: exact pixels, transparent corners.
let page;
async function render(svg, size) {
  page ??= await (async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html,<html><body></body></html>");
    return win;
  })();
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const dataUrl = await page.webContents.executeJavaScript(`new Promise((done) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = ${size};
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, ${size}, ${size});
      done(c.toDataURL("image/png"));
    };
    img.src = "${url}";
  })`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// ICONDIR, one ICONDIRENTRY per image, then the PNGs.
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const big = readFileSync(join(DIR, "icon.svg"), "utf8");
  const small = readFileSync(join(DIR, "icon-small.svg"), "utf8");
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, png: await render(size <= 32 ? small : big, size) });
  writeFileSync(join(DIR, "icon.ico"), ico(pngs));
  writeFileSync(join(DIR, "icon-256.png"), pngs.at(-1).png);
  writeFileSync(join(DIR, "icon-32.png"), pngs.find((p) => p.size === 32).png);
  console.log(`icon.ico: ${SIZES.join(", ")} px`);
  page?.destroy();
  app.quit();
});
