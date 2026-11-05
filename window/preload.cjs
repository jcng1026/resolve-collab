// The only bridge between the page and Electron (SPEC §24): the page gets
// state and layout, and sends plain action objects. No Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rc", {
  on: (channel, fn) => {
    if (["state", "layout", "prefs"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  send: (message) => ipcRenderer.send("rc", message),
});
