import { initPlayer, openPlayer, closePlayer, maybeShowSummary } from "./player.mjs";

const songsEl = document.getElementById("songs");
const stagesEl = document.getElementById("stages");
const logEl = document.getElementById("log");
const addBtn = document.getElementById("add");
const fastEl = document.getElementById("fast");
const viewLibrary = document.getElementById("view-library");
const viewPlayer = document.getElementById("view-player");
const backBtn = document.getElementById("back");

// Mirrors the sidecar's emit() stages, in pipeline order.
const STAGES = ["probe", "separate", "contour", "lyrics", "bundle"];
const STAGE_LABELS = {
  probe: "Read tags",
  separate: "Split vocals (Demucs)",
  contour: "Reference pitch",
  lyrics: "Synced lyrics (LRClib)",
  bundle: "Bundle",
};

let busy = false;
let pendingAutoplay = false;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function log(line) {
  logEl.textContent += line.endsWith("\n") ? line : line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtDuration(s) {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

async function refresh() {
  const songs = await window.karaoke.listSongs();
  if (!songs.length) {
    songsEl.innerHTML = '<p class="empty">No songs yet. Add an mp3 to build your first bundle.</p>';
    return;
  }
  songsEl.innerHTML = songs
    .map(
      (s) => `
      <div class="song" data-bundle="${esc(s.bundle)}" data-id="${esc(s.id)}">
        <div class="song-main">
          <span class="song-title">${esc(s.title || "Unknown title")}</span>
          <span class="song-artist">${esc(s.artist || "Unknown artist")}</span>
        </div>
        <div class="song-side">
          <span class="badge">${fmtDuration(s.duration_s)}</span>
          <span class="badge ${s.hasLyrics ? "ok" : "dim"}">${s.hasLyrics ? "lyrics" : "no lyrics"}</span>
          <span class="badge ${s.stages && s.stages.contour === "done" ? "ok" : "dim"}">pitch</span>
          <button class="reveal" title="Show bundle in Finder">⌖</button>
        </div>
      </div>`
    )
    .join("");
  for (const el of songsEl.querySelectorAll(".song .reveal")) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const bundle = e.target.closest(".song").dataset.bundle;
      window.karaoke.revealBundle(bundle);
    });
  }
  for (const el of songsEl.querySelectorAll(".song")) {
    el.addEventListener("click", () => {
      pendingAutoplay = true; // click is the user gesture that allows playback
      location.hash = `play/${el.dataset.id}`;
    });
  }
}

// Routing: "" → library, "#play/<id>[?t=<s>]" → player.
function route() {
  const m = location.hash.match(/^#play\/([0-9a-f]+)(?:\?t=([\d.]+))?$/);
  if (m) {
    viewLibrary.hidden = true;
    viewPlayer.hidden = false;
    openPlayer(m[1], { t: Number(m[2] || 0), autoplay: pendingAutoplay });
  } else {
    closePlayer();
    viewPlayer.hidden = true;
    viewLibrary.hidden = false;
    refresh();
  }
  pendingAutoplay = false;
}

window.addEventListener("hashchange", route);
backBtn.addEventListener("click", () => {
  // A sung run gets its verdict before leaving; second Back actually leaves.
  if (!maybeShowSummary()) location.hash = "";
});

window.karaoke.onProgress((msg) => {
  setStage(msg.stage, msg.status);
  if (msg.status === "error") log(`ERROR [${msg.stage}] ${msg.message || ""}`);
  if (msg.status === "warn") log(`warn [${msg.stage}] ${msg.message || ""}`);
  if (msg.stage === "probe" && msg.status === "done") {
    log(`probed: ${msg.artist || "?"} — ${msg.title || "?"} (${fmtDuration(msg.duration_s)})`);
  }
  if (msg.stage === "lyrics" && msg.status === "done") {
    log(msg.found ? "synced lyrics found" : "no synced lyrics (pitch-only bundle)");
  }
  if (msg.stage === "bundle" && msg.status === "done" && msg.cached) {
    log("already processed (cached bundle)");
  }
});

function setStage(stage, status) {
  let chip = stagesEl.querySelector(`[data-stage="${stage}"]`);
  if (!chip) {
    chip = document.createElement("span");
    chip.dataset.stage = stage;
    chip.className = "chip";
    chip.textContent = STAGE_LABELS[stage] || stage;
    stagesEl.appendChild(chip);
  }
  chip.classList.remove("pending", "start", "done", "error", "warn");
  chip.classList.add(status);
}

window.karaoke.onLog((line) => log(line.trimEnd()));

addBtn.addEventListener("click", async () => {
  if (busy) return;
  const file = await window.karaoke.pickAudio();
  if (!file) return;
  busy = true;
  addBtn.disabled = true;
  stagesEl.innerHTML = "";
  logEl.textContent = "";
  STAGES.forEach((s) => setStage(s, "pending"));
  const res = await window.karaoke.processSong(file, { fast: fastEl.checked });
  log(res.ok ? "✓ bundle complete" : `✗ sidecar failed (${res.error || "exit " + res.code})`);
  busy = false;
  addBtn.disabled = false;
  refresh();
});

initPlayer();
route();
