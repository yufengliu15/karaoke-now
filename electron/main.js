const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SIDECAR_DIR = path.join(__dirname, "..", "sidecar");

function sidecarPython() {
  if (process.env.KARAOKE_PY) return process.env.KARAOKE_PY;
  const venv = path.join(SIDECAR_DIR, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

function songsRoot() {
  const root = path.join(app.getPath("userData"), "songs");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#101014",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  console.log("[karaoke-now] ready; songs root:", songsRoot());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("pick-audio", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose a song",
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "flac", "ogg"] }],
    properties: ["openFile"],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("list-songs", async () => {
  const root = songsRoot();
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const metaPath = path.join(root, id, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      meta.bundle = path.join(root, id);
      meta.hasLyrics = fs.existsSync(path.join(root, id, "lyrics.lrc"));
      out.push(meta);
    } catch {
      // corrupt bundle: skip, leave on disk for manual inspection
    }
  }
  out.sort((a, b) => (b.processed_at || "").localeCompare(a.processed_at || ""));
  return out;
});

ipcMain.handle("process-song", async (_e, filePath, opts = {}) => {
  const args = ["-m", "karaoke_sidecar.cli", "process", filePath, "--out", songsRoot()];
  if (opts.fast) args.push("--fast");
  if (opts.engine) args.push("--engine", opts.engine);

  return new Promise((resolve) => {
    const child = spawn(sidecarPython(), args, { cwd: SIDECAR_DIR });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        // stdout is the JSON progress protocol; anything unparseable goes to the log pane
        try {
          win.webContents.send("sidecar-progress", JSON.parse(line));
        } catch {
          win.webContents.send("sidecar-log", line);
        }
      }
    });
    child.stderr.on("data", (d) => win.webContents.send("sidecar-log", d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: String(err) }));
    child.on("close", (code) => resolve({ ok: code === 0, code }));
  });
});

ipcMain.handle("reveal-bundle", async (_e, bundlePath) => {
  shell.showItemInFolder(path.join(bundlePath, "meta.json"));
});
