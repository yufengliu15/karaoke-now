const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, systemPreferences } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const SIDECAR_DIR = path.join(__dirname, "..", "sidecar");
const RENDERER_DIR = path.join(__dirname, "..", "renderer");

// Renderer + song bundles are served over one privileged scheme so the page
// gets a real origin: ES modules, fetch(), and <audio> all same-origin under
// CSP 'self' (file:// would CORS-block module scripts and fetch).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function sidecarPython() {
  if (process.env.KARAOKE_PY) return process.env.KARAOKE_PY;
  const venv = path.join(SIDECAR_DIR, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

function songsRoot() {
  const root = process.env.KARAOKE_SONGS_DIR || path.join(app.getPath("userData"), "songs");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".lrc": "text/plain",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Manual file serving with Range support: <audio> seeking sends Range
// requests, and a stalled seek means a frozen player on any 30MB wav.
function serveFile(root, rel, req) {
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return new Response("not found", { status: 404 });
  }
  const size = fs.statSync(full).size;
  const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("Range") || "");

  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = Math.min(range[2] && range[1] ? Number(range[2]) : size - 1, size - 1);
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(full, { start, end })), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(full)), {
    headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size) },
  });
}

function handleAppRequest(req) {
  const url = new URL(req.url);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (rel.startsWith("songs/")) return serveFile(songsRoot(), rel.slice("songs/".length), req);
  return serveFile(RENDERER_DIR, rel || "index.html", req);
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
  win.loadURL("app://karaoke/index.html" + (process.env.KARAOKE_SHOT_HASH || ""));
}

// Dev/verification harness: KARAOKE_SHOT_DIR=/tmp/shots [KARAOKE_SHOT_HASH="#play/<id>?t=12"]
// captures the window after load, then quits.
function armScreenshot() {
  if (!process.env.KARAOKE_SHOT_DIR) return;
  const dir = process.env.KARAOKE_SHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  win.webContents.on("did-finish-load", () => {
    setTimeout(async () => {
      if (process.env.KARAOKE_SHOT_PLAY) {
        // Playback probe: press play, let it run, report the clock (it only
        // advances off audio.currentTime, so movement proves audio is playing).
        const clk = () => win.webContents.executeJavaScript('document.getElementById("p-clock").textContent');
        await win.webContents.executeJavaScript('document.getElementById("playpause").click()');
        if (process.env.KARAOKE_FAKE_MIC) {
          await win.webContents.executeJavaScript('document.getElementById("mic").click()');
        }
        const before = await clk();
        await new Promise((r) => setTimeout(r, 3000));
        console.log(`[karaoke-now] playback probe: "${before}" -> "${await clk()}"`);
        if (process.env.KARAOKE_FAKE_MIC) {
          // Loop proof: fake oscillator in, YIN estimates out, trace on canvas.
          const probe = await win.webContents.executeJavaScript(`(() => {
            const p = window.__micProbe;
            if (!p) return "no probe";
            const f = [...p.f0s].sort((a, b) => a - b);
            return JSON.stringify({ messages: p.messages, voiced: p.voiced,
              latencyMs: p.latencyMs, f0Median: f[f.length >> 1] ?? 0 });
          })()`);
          console.log("[karaoke-now] mic probe:", probe);
        }
      }
      const img = await win.webContents.capturePage();
      const name = process.env.KARAOKE_SHOT_HASH ? "player.png" : "library.png";
      fs.writeFileSync(path.join(dir, name), img.toPNG());
      console.log("[karaoke-now] screenshot:", path.join(dir, name));
      app.quit();
    }, Number(process.env.KARAOKE_SHOT_DELAY_MS || 1500));
  });
}

app.whenReady().then(() => {
  protocol.handle("app", handleAppRequest);
  // Mic capture is the only permission the renderer ever needs (Phase 3
  // getUserMedia); deny everything else. On macOS the OS-level TCC prompt
  // must be requested explicitly or getUserMedia fails silently.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission !== "media") return callback(false);
    if (process.platform === "darwin") {
      systemPreferences.askForMediaAccess("microphone").then(callback);
    } else {
      callback(true);
    }
  });
  createWindow();
  armScreenshot();
  console.log("[karaoke-now] ready; songs root:", songsRoot());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.KARAOKE_SHOT_DIR) app.quit();
});

// Harness knob: KARAOKE_FAKE_MIC=<hz> swaps getUserMedia for an oscillator so
// the live loop is verifiable headless. Sync because preload reads it once.
ipcMain.on("fake-mic-hz", (e) => {
  e.returnValue = process.env.KARAOKE_FAKE_MIC || "";
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
