// Playback screen: instrumental audio + scrolling pitch lane + synced lyrics.
// Geometry/parsing live in pitchlane.mjs / lrc.mjs (unit-tested); this module
// owns the DOM, the <audio> clock, and the rAF render loop.

import { parseLrc, activeLineIndex, wordTimings } from "./lrc.mjs";
import {
  buildNotes,
  fitMidiRange,
  timeToX,
  midiToY,
  hzToMidi,
  foldMidiToRange,
} from "./pitchlane.mjs";
import { LiveNoteTracker } from "./livenotes.mjs";
import { startMic } from "./mic.mjs";

const WINDOW_S = 8; // seconds of contour visible across the lane
const LEAD_FRAC = 0.25; // now-line position as a fraction of lane width

// Voicing gates on live mic estimates: YIN clarity on real singing sits well
// above 0.6; the RMS floor keeps silence and breath off the lane.
const CLARITY_MIN = 0.6;
const RMS_FLOOR = 0.005;

// "any": octave-fold the sung pitch into the lane — only the note name has
// to match. "exact": the register matters; an octave off drifts off-lane.
const OCTAVE_MODES = { any: "Any octave", exact: "Exact octave" };
let octaveMode = localStorage.getItem("karaoke-octave-mode") || "any";

const els = {};
let css = {};
let state = null;
let rafId = 0;
let currentSession = null;
let mic = null; // live mic engine, one at a time, stopped on player close
let lastVoicedMs = 0; // wall-clock time of the last voiced estimate

export function initPlayer() {
  for (const id of ["view-player", "back", "p-title", "p-artist", "p-clock", "lane", "lyrics", "lyrics-empty", "playpause", "mic", "mic-note", "octave", "seek"]) {
    els[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
  const style = getComputedStyle(document.body);
  css = {
    accent: style.getPropertyValue("--accent").trim(),
    muted: style.getPropertyValue("--muted").trim(),
    border: style.getPropertyValue("--border").trim(),
    text: style.getPropertyValue("--text").trim(),
    ok: style.getPropertyValue("--ok").trim(),
  };

  els.playpause.addEventListener("click", togglePlay);
  els.mic.addEventListener("click", toggleMic);
  els.octave.textContent = OCTAVE_MODES[octaveMode];
  els.octave.addEventListener("click", () => {
    octaveMode = octaveMode === "any" ? "exact" : "any";
    localStorage.setItem("karaoke-octave-mode", octaveMode);
    els.octave.textContent = OCTAVE_MODES[octaveMode];
  });
  document.addEventListener("keydown", (e) => {
    if (state && e.code === "Space" && e.target.tagName !== "INPUT") {
      e.preventDefault();
      togglePlay();
    }
  });
  els.seek.addEventListener("input", () => {
    if (!state) return;
    state.audio.currentTime = Number(els.seek.value);
    state.liveNotes.reset(); // bar times are song-relative; a seek orphans them
  });
  els.seek.addEventListener("pointerdown", () => state && (state.scrubbing = true));
  els.seek.addEventListener("pointerup", () => state && (state.scrubbing = false));
  new ResizeObserver(resizeLane).observe(els.lane);
}

export async function openPlayer(id, { t = 0, autoplay = false } = {}) {
  closePlayer();
  const session = (currentSession = {});

  const [meta, contour, lrcText] = await Promise.all([
    fetchJson(`/songs/${id}/meta.json`),
    fetchJson(`/songs/${id}/contour.json`),
    fetchText(`/songs/${id}/lyrics.lrc`),
  ]);
  if (currentSession !== session) return; // navigated away while loading

  els.pTitle.textContent = meta?.title || "Unknown title";
  els.pArtist.textContent = meta?.artist || "";

  const audio = new Audio(`/songs/${id}/instrumental.wav`);
  audio.preload = "auto";
  state = {
    id,
    audio,
    notes: [],
    range: { lo: 48, hi: 72 },
    lines: [],
    lineIdx: -2,
    words: [],
    wordIdx: -1,
    scrubbing: false,
    liveNotes: new LiveNoteTracker(), // live mic estimates → stable note bars
    // Streamed wav reports duration=Infinity until fully buffered; meta.json is the truth.
    durationS: meta?.duration_s || 0,
  };

  const syncDuration = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) state.durationS = audio.duration;
    els.seek.max = state.durationS.toFixed(1);
  };
  audio.addEventListener("loadedmetadata", () => {
    syncDuration();
    if (t) audio.currentTime = t;
    els.playpause.disabled = false;
  });
  audio.addEventListener("durationchange", syncDuration);
  audio.addEventListener("play", () => (els.playpause.textContent = "Pause"));
  audio.addEventListener("pause", () => (els.playpause.textContent = "Play"));

  if (contour) {
    state.notes = buildNotes(contour);
    const fit = fitMidiRange(contour);
    // Whole semitones so gridlines and note bars land on the same rows.
    state.range = { lo: Math.floor(fit.lo), hi: Math.ceil(fit.hi) };
  }
  state.lines = lrcText ? parseLrc(lrcText).lines : [];
  renderLyricsList();

  resizeLane();
  if (autoplay) audio.play().catch(() => {});
  rafId = requestAnimationFrame(tick);
}

export function closePlayer() {
  currentSession = null;
  cancelAnimationFrame(rafId);
  stopMic();
  if (state) {
    state.audio.pause();
    state.audio.removeAttribute("src");
    state.audio.load();
  }
  state = null;
  els.playpause.disabled = true;
  els.playpause.textContent = "Play";
  els.lyrics.querySelectorAll(".line").forEach((n) => n.remove());
}

function togglePlay() {
  if (!state) return;
  state.audio.paused ? state.audio.play().catch(() => {}) : state.audio.pause();
}

async function toggleMic() {
  if (mic) {
    stopMic();
    return;
  }
  els.mic.disabled = true;
  try {
    const fakeHz = Number(window.karaoke.fakeMicHz || 0);
    mic = await startMic({ onSample: onMicSample, fakeHz });
    (window.__micProbe ??= { messages: 0, voiced: 0, f0s: [] }).latencyMs = mic.latencyMs;
    els.mic.textContent = "Mic on";
    els.mic.classList.add("on");
  } catch (err) {
    console.error("mic start failed:", err);
    els.micNote.textContent = "mic blocked";
  }
  els.mic.disabled = false;
}

function stopMic() {
  if (mic) mic.stop();
  mic = null;
  els.mic.textContent = "Mic off";
  els.mic.classList.remove("on");
  els.micNote.textContent = "";
}

function onMicSample(d) {
  // Probe: lets the headless harness assert the loop end to end (fake mic in,
  // ~fakeHz out). Negligible cost when nobody reads it.
  const probe = (window.__micProbe ??= { messages: 0, voiced: 0, f0s: [] });
  probe.messages++;

  const voiced = d.f0 > 0 && d.clarity >= CLARITY_MIN && d.rms >= RMS_FLOOR;
  if (!voiced) return; // readout clears on sustained silence in tick()
  lastVoicedMs = performance.now();
  probe.voiced++;
  probe.f0s.push(Math.round(d.f0 * 10) / 10);
  if (probe.f0s.length > 200) probe.f0s.shift();

  if (!state || !mic || state.audio.paused) return;

  // In "any octave" mode the sung pitch is folded into the lane before the
  // tracker sees it, so the held bar lands on the reference melody. In
  // "exact" mode the raw register goes through untouched.
  let midi = hzToMidi(d.f0);
  if (octaveMode === "any") midi = foldMidiToRange(midi, state.range.lo, state.range.hi);

  // d.t is the ctx time of the analysis-window center; subtracting its age
  // from the song clock pins the sample to the moment it was actually sung.
  const songT = state.audio.currentTime - Math.max(0, mic.ctx.currentTime - d.t);
  state.liveNotes.push(songT, midi);

  const held = state.liveNotes.note();
  els.micNote.textContent = held === null ? "" : noteName(held);
  probe.bars = state.liveNotes.bars().length;
}

function noteName(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

function renderLyricsList() {
  els.lyricsEmpty.hidden = state.lines.length > 0;
  for (const line of state.lines) {
    const div = document.createElement("div");
    div.className = "line";
    div.textContent = line.text || "♪";
    els.lyrics.appendChild(div);
  }
}

function fmtClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function tick() {
  rafId = requestAnimationFrame(tick);
  const now = state.audio.currentTime;

  drawLane(now);

  if (mic && els.micNote.textContent && performance.now() - lastVoicedMs > 300) {
    els.micNote.textContent = "";
  }

  const clock = `${fmtClock(now)} / ${fmtClock(state.durationS)}`;
  if (els.pClock.textContent !== clock) els.pClock.textContent = clock;
  if (!state.scrubbing) els.seek.value = now;

  const idx = activeLineIndex(state.lines, now);
  if (idx !== state.lineIdx) {
    const firstSync = state.lineIdx === -2;
    state.lineIdx = idx;
    const lineEls = els.lyrics.querySelectorAll(".line");
    lineEls.forEach((el, i) => {
      el.classList.toggle("active", i === idx);
      el.classList.toggle("past", i < idx);
      if (i !== idx && el.dataset.wordy) {
        el.textContent = state.lines[i].text || "♪"; // back to plain text
        delete el.dataset.wordy;
      }
    });
    const active = lineEls[idx];
    if (active) {
      const lineEndT = state.lines[idx + 1]?.t ?? state.durationS;
      renderActiveWords(active, state.lines[idx], lineEndT);
      els.lyrics.scrollTo({
        top: active.offsetTop - els.lyrics.clientHeight / 2 + active.clientHeight / 2,
        behavior: firstSync ? "auto" : "smooth",
      });
    } else {
      state.words = [];
      state.wordIdx = -1;
    }
  }

  // Word sweep within the active line.
  if (state.words.length) {
    const wi = activeLineIndex(state.words, now);
    if (wi !== state.wordIdx) {
      state.wordIdx = wi;
      els.lyrics
        .querySelectorAll(".line.active .word")
        .forEach((s, i) => s.classList.toggle("sung", i <= wi));
    }
  }
}

function renderActiveWords(el, line, lineEndT) {
  state.words = wordTimings(line, lineEndT);
  state.wordIdx = -1;
  el.dataset.wordy = "1";
  el.textContent = "";
  state.words.forEach((w, i) => {
    if (i) el.append(" ");
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w.text;
    el.appendChild(span);
  });
  if (!state.words.length) el.textContent = line.text || "♪";
}

function resizeLane() {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = els.lane;
  if (!w || !h) return;
  els.lane.width = Math.round(w * dpr);
  els.lane.height = Math.round(h * dpr);
  const ctx = els.lane.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state) drawLane(state.audio.currentTime);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function drawLane(now) {
  const ctx = els.lane.getContext("2d");
  const width = els.lane.clientWidth;
  const height = els.lane.clientHeight;
  if (!width || !height) return;
  const geo = { width, windowS: WINDOW_S, leadFrac: LEAD_FRAC };
  const { lo, hi } = state.range;
  const yOpts = { lo, hi, height };
  const rowH = height / (hi - lo);

  ctx.clearRect(0, 0, width, height);

  // Semitone grid: every note gets a line. Labels are drawn after the bars
  // so the axis stays readable when a note sits at the left edge.
  ctx.lineWidth = 1;
  ctx.strokeStyle = css.border;
  for (let midi = lo; midi <= hi; midi++) {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    ctx.globalAlpha = name === "C" ? 0.95 : name.includes("#") ? 0.25 : 0.55;
    const y = midiToY(midi, yOpts);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Reference notes as held bars: muted left of the now-line (sung), accent ahead.
  const nowX = LEAD_FRAC * width;
  const tMin = now - LEAD_FRAC * WINDOW_S;
  const tMax = tMin + WINDOW_S;
  const barH = Math.min(Math.max(rowH * 0.72, 4), 18);
  for (const [color, x0, x1] of [
    [css.muted, 0, nowX],
    [css.accent, nowX, width],
  ]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, height);
    ctx.clip();
    ctx.fillStyle = color;
    for (const n of state.notes) {
      if (n.t1 < tMin || n.t0 > tMax) continue;
      const bx0 = timeToX(n.t0, now, geo);
      const bx1 = timeToX(n.t1, now, geo);
      const y = midiToY(n.midi, yOpts);
      ctx.beginPath();
      ctx.roundRect(bx0, y - barH / 2, Math.max(bx1 - bx0, 3), barH, barH / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Live user bars: the singer's held notes, quantized and stabilized the
  // same way as the reference (LiveNoteTracker), drawn thinner and green so
  // both layers stay readable. Clipped at the now-line.
  const liveBars = state.liveNotes.bars();
  if (liveBars.length) {
    const uBarH = Math.min(Math.max(rowH * 0.45, 3), 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, nowX, height);
    ctx.clip();
    ctx.fillStyle = css.ok;
    ctx.globalAlpha = 0.95;
    for (const b of liveBars) {
      if (b.t1 < tMin || b.t0 > tMax) continue;
      const bx0 = timeToX(b.t0, now, geo);
      const bx1 = timeToX(b.t1, now, geo);
      const y = midiToY(b.midi, yOpts);
      ctx.beginPath();
      ctx.roundRect(bx0, y - uBarH / 2, Math.max(bx1 - bx0, 3), uBarH, uBarH / 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Note labels on top of the bars.
  ctx.font = "10px ui-monospace, monospace";
  for (let midi = lo; midi <= hi; midi++) {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    if (name.includes("#") || (rowH < 11 && name !== "C")) continue;
    ctx.fillStyle = css.muted;
    ctx.globalAlpha = name === "C" ? 1 : 0.75;
    ctx.fillText(`${name}${Math.floor(midi / 12) - 1}`, 6, midiToY(midi, yOpts) - 3);
  }
  ctx.globalAlpha = 1;

  // Now-line.
  ctx.strokeStyle = css.text;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, height);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
