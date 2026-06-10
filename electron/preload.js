const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("karaoke", {
  pickAudio: () => ipcRenderer.invoke("pick-audio"),
  listSongs: () => ipcRenderer.invoke("list-songs"),
  processSong: (filePath, opts) => ipcRenderer.invoke("process-song", filePath, opts),
  revealBundle: (bundlePath) => ipcRenderer.invoke("reveal-bundle", bundlePath),
  onProgress: (cb) => ipcRenderer.on("sidecar-progress", (_e, msg) => cb(msg)),
  onLog: (cb) => ipcRenderer.on("sidecar-log", (_e, line) => cb(line)),
  fakeMicHz: ipcRenderer.sendSync("fake-mic-hz"),
});
