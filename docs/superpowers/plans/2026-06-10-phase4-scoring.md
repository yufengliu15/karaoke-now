# Phase 4 — Scoring + Session Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-tune-percent scoring per phrase (LRC line) plus an end-of-song session summary overlay — the MVP exit criterion: pick a song, sing it, get an honest percent.

**Architecture:** Collect-then-batch-score. While the mic is on and audio plays, raw sung midis are bucketed per 10ms frame in a Map (overwrite semantics — re-singing after a seek rescores). At song end (or Back with a sung run), one pure function `scoreSession()` in a new `renderer/score.mjs` computes per-phrase and total percentages against a precomputed reference (`prepRef()`). A plain-HTML overlay renders the result. Nothing persists. Spec: `docs/superpowers/specs/2026-06-10-phase4-scoring-design.md`.

**Tech Stack:** Vanilla ES modules, `node:test` (existing test style), Electron headless harness (`KARAOKE_SHOT_*` env knobs), no new dependencies.

**Conventions:** Match existing code style — `//`-comment voice explaining *why*, pure modules with no DOM, `DEFAULTS`-style opts objects, tests in `renderer/tests/*.test.mjs` run by `npm test`. Run all commands from `/Users/yufeng/karaoke-now`. Branch: `phase-4-scoring` (already created).

---

## Existing interfaces the new code uses (do not re-derive)

- `contour.json`: `{ f0_hz: number[], confidence: number[], hop_ms: 10, ... }` — raw, no voicing threshold applied.
- `renderer/pitchlane.mjs` exports `hzToMidi(hz)` (440→69) and `medianSmooth(values, win)` (running median, edge-truncated).
- `renderer/lrc.mjs` `parseLrc(text).lines` → `[{ t: seconds, text: string, words? }]`, sorted by `t`.
- `renderer/player.mjs`: `state` holds `audio`, `lines`, `durationS`, `liveNotes`; `onMicSample(d)` receives `{ t, f0, clarity, rms }`, already gates voicing (`CLARITY_MIN = 0.6`, `RMS_FLOOR = 0.005`) and computes `songT` (song-clock time the sample was sung). `octaveMode` is `"any" | "exact"`, persisted in localStorage. `els` is built from an id list in `initPlayer()` (kebab-case ids → camelCase keys).
- `renderer/app.js` owns navigation: `backBtn.addEventListener("click", () => { location.hash = ""; })`.
- `electron/main.js` `armScreenshot()` is the headless harness; `scripts/make_synth_bundle.py` writes a synthetic bundle to `/tmp/karaoke-test-songs/deadbeefdeadbeef` (30s C-major melody, LRC every 2.4s).

---

### Task 1: `prepRef()` — reference preprocessing

**Files:**
- Create: `renderer/tests/score.test.mjs`
- Create: `renderer/score.mjs`

- [ ] **Step 1: Write the failing tests**

Create `renderer/tests/score.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepRef, scoreSession } from "../score.mjs";

const HOP_MS = 10; // all tests use 10ms frames: frame index == centiseconds

// Contour from per-frame midis; null = unvoiced frame.
function contourFrom(midis, conf = 0.95) {
  return {
    hop_ms: HOP_MS,
    f0_hz: midis.map((m) => (m === null ? 0 : 440 * 2 ** ((m - 69) / 12))),
    confidence: midis.map((m) => (m === null ? 0.05 : conf)),
  };
}

// Buckets: every frame in [i0, i1) sung at midi (number or fn of frame index).
function sing(i0, i1, midi) {
  const m = new Map();
  for (let i = i0; i < i1; i++) m.set(i, typeof midi === "function" ? midi(i) : midi);
  return m;
}

test("prepRef: unvoiced and low-confidence frames are not scorable", () => {
  const midis = Array(100).fill(69);
  for (let i = 40; i < 50; i++) midis[i] = null; // unvoiced gap
  const contour = contourFrom(midis);
  for (let i = 70; i < 80; i++) contour.confidence[i] = 0.2; // low confidence
  const ref = prepRef(contour, { onsetGateS: 0 });
  assert.equal(ref.scorable[20], 1);
  assert.equal(ref.scorable[45], 0);
  assert.equal(ref.scorable[75], 0);
  assert.ok(Number.isNaN(ref.refMidi[45]));
  assert.equal(ref.hopS, 0.01);
});

test("prepRef: onset gate blanks the first 80ms of each note", () => {
  // One voiced run from frame 10, semitone switch at frame 50.
  const midis = Array(100).fill(null);
  for (let i = 10; i < 50; i++) midis[i] = 69;
  for (let i = 50; i < 90; i++) midis[i] = 71;
  const ref = prepRef(contourFrom(midis)); // default onsetGateS 0.08 → 8 frames
  assert.equal(ref.scorable[10], 0); // run onset
  assert.equal(ref.scorable[17], 0);
  assert.equal(ref.scorable[18], 1);
  assert.equal(ref.scorable[50], 0); // semitone-switch onset
  assert.equal(ref.scorable[57], 0);
  assert.equal(ref.scorable[58], 1);
});

test("prepRef: median smoothing kills single-frame octave blips", () => {
  const midis = Array(50).fill(69);
  midis[25] = 81; // octave error, one frame
  const ref = prepRef(contourFrom(midis), { onsetGateS: 0 });
  assert.ok(Math.abs(ref.refMidi[25] - 69) < 0.01);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module ... score.mjs`

- [ ] **Step 3: Implement `prepRef`**

Create `renderer/score.mjs`:

```js
// In-tune-percent scoring: collected mic frames vs the reference contour,
// per phrase (LRC line) and per session. Pure module: no DOM, unit-tested.
// Every fairness lever lives in SCORE_OPTS — tuned by singing, not by math.

import { hzToMidi, medianSmooth } from "./pitchlane.mjs";

export const SCORE_OPTS = {
  tolCents: 50, // in-tune band around the reference
  refConfMin: 0.5, // reference frames below this confidence never score
  refSmooth: 5, // median frames over the reference f0 (kills octave blips)
  onsetGateS: 0.08, // scoop forgiveness: everyone slides into note starts
  userMedianS: 0.06, // window for judging vibrato at its center
};

// Reference contour → per-frame midi + scorable mask, computed once per song.
// Scorable = voiced (confidence-gated) and past the onset gate of its note.
export function prepRef(contour, opts = {}) {
  const o = { ...SCORE_OPTS, ...opts };
  const { f0_hz: f0, confidence: conf, hop_ms } = contour;
  const hopS = hop_ms / 1000;
  const n = f0.length;
  const refMidi = new Float64Array(n).fill(NaN);
  const scorable = new Uint8Array(n);
  const gate = Math.round(o.onsetGateS / hopS);
  const onsets = [];

  let run = [];
  const flush = () => {
    if (run.length) {
      const midis = medianSmooth(run.map((i) => f0[i]), o.refSmooth).map(hzToMidi);
      for (let k = 0; k < run.length; k++) {
        refMidi[run[k]] = midis[k];
        scorable[run[k]] = 1;
        if (k === 0 || Math.round(midis[k]) !== Math.round(midis[k - 1])) onsets.push(run[k]);
      }
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (f0[i] > 0 && conf[i] >= o.refConfMin) run.push(i);
    else flush();
  }
  flush();

  for (const at of onsets) {
    for (let i = at; i < Math.min(at + gate, n); i++) scorable[i] = 0;
  }
  return { refMidi, scorable, hopS, opts: o };
}

export function scoreSession() {
  throw new Error("not implemented"); // Task 2
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: the three `prepRef` tests PASS; all pre-existing suites still pass.

- [ ] **Step 5: Commit**

```bash
git add --all && git commit -m "feat: prepRef — reference voicing mask, smoothing, onset gate"
```

---

### Task 2: `scoreSession()` — frame math

**Files:**
- Modify: `renderer/score.mjs`
- Modify: `renderer/tests/score.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `renderer/tests/score.test.mjs`:

```js
// Constant reference at midi 69, onset gate disabled so frame math is exact.
function flatRef(frames = 200) {
  return prepRef(contourFrom(Array(frames).fill(69)), { onsetGateS: 0 });
}
const flatArgs = (buckets, octaveMode = "any") => ({
  buckets,
  ref: flatRef(),
  lines: [],
  durationS: 2,
  octaveMode,
});

test("perfect unison scores 100", () => {
  const res = scoreSession(flatArgs(sing(0, 200, 69)));
  assert.equal(res.totalPct, 100);
  assert.equal(res.scoredS, 2);
});

test("constant +100 cents scores 0", () => {
  assert.equal(scoreSession(flatArgs(sing(0, 200, 70))).totalPct, 0);
});

test("half in tune scores 50", () => {
  const buckets = new Map([...sing(0, 100, 69), ...sing(100, 200, 71)]);
  assert.equal(scoreSession(flatArgs(buckets)).totalPct, 50);
});

test("octave down: 100 in any-octave mode, 0 in exact mode", () => {
  assert.equal(scoreSession(flatArgs(sing(0, 200, 57))).totalPct, 100);
  assert.equal(scoreSession(flatArgs(sing(0, 200, 57), "exact")).totalPct, 0);
});

test("silence scores 0 — not singing counts against you", () => {
  assert.equal(scoreSession(flatArgs(new Map())).totalPct, 0);
});

test("nothing scorable in the reference scores null", () => {
  const ref = prepRef(contourFrom(Array(50).fill(null)));
  const res = scoreSession({ buckets: sing(0, 50, 69), ref, lines: [], durationS: 0.5 });
  assert.equal(res.totalPct, null);
});

test("vibrato over the band is rescued by the 60ms median", () => {
  // ±55¢ at 6Hz: raw frames near the peaks sit outside the ±50¢ band, but
  // the median window judges the vibrato at its center (worst-case window
  // median ≈ 46¢), so every frame scores in tune.
  const vib = (i) => 69 + 0.55 * Math.sin(2 * Math.PI * 6 * (i / 100));
  assert.equal(scoreSession(flatArgs(sing(0, 200, vib))).totalPct, 100);
});

test("single-frame user blip is absorbed by the median window", () => {
  const buckets = sing(0, 200, 69);
  buckets.set(100, 81);
  assert.equal(scoreSession(flatArgs(buckets)).totalPct, 100);
});

test("later writes overwrite earlier ones", () => {
  const buckets = sing(0, 200, 81); // first pass: octave off everywhere
  for (const [k] of buckets) buckets.set(k, 69); // re-sing in tune
  assert.equal(scoreSession(flatArgs(buckets)).totalPct, 100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: new tests FAIL with "not implemented".

- [ ] **Step 3: Implement `scoreSession`**

Replace the `scoreSession` stub in `renderer/score.mjs` with:

```js
// buckets: Map(frame index → sung midi, raw/unfolded), collected by the
// player during a run. Later writes overwrite earlier ones, so re-singing a
// section after a seek rescores it. Score = in-tune / scorable: frames the
// reference sings but the user doesn't count against the percent.
export function scoreSession({ buckets, ref, lines = [], durationS, octaveMode = "any", opts = {} }) {
  const o = { ...ref.opts, ...opts };
  const { refMidi, scorable, hopS } = ref;
  const n = refMidi.length;
  const half = Math.max(0, Math.round(o.userMedianS / 2 / hopS));

  const inTune = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!scorable[i]) continue;
    const win = [];
    for (let k = i - half; k <= i + half; k++) {
      const m = buckets.get(k);
      if (m !== undefined) win.push(m);
    }
    if (!win.length) continue;
    win.sort((a, b) => a - b);
    let cents = (win[win.length >> 1] - refMidi[i]) * 100;
    if (octaveMode === "any") {
      // Pitch-class distance: octave-down on an out-of-range song is
      // legitimate karaoke, so only the note name has to match.
      cents = ((cents % 1200) + 1200) % 1200;
      if (cents > 600) cents -= 1200;
    }
    if (Math.abs(cents) <= o.tolCents) inTune[i] = 1;
  }

  // Phrase boundaries from LRC line stamps; no lyrics → one whole-song phrase.
  const spans = [];
  if (lines.length) {
    if (lines[0].t > 0) spans.push({ text: "♪", t0: 0, t1: lines[0].t, lead: true });
    lines.forEach((line, i) => {
      spans.push({ text: line.text, t0: line.t, t1: lines[i + 1]?.t ?? durationS });
    });
  } else {
    spans.push({ text: "", t0: 0, t1: durationS });
  }

  let totalScorable = 0;
  let totalInTune = 0;
  const phrases = [];
  for (const span of spans) {
    const i0 = Math.max(0, Math.round(span.t0 / hopS));
    const i1 = Math.min(n, Math.round(span.t1 / hopS));
    let sc = 0;
    let it = 0;
    for (let i = i0; i < i1; i++) {
      sc += scorable[i];
      it += inTune[i];
    }
    if (span.lead && !sc) continue; // intro with no melody: no row at all
    totalScorable += sc;
    totalInTune += it;
    phrases.push({
      text: span.text,
      t0: span.t0,
      t1: span.t1,
      pct: sc ? Math.round((100 * it) / sc) : null,
      scorableS: sc * hopS,
    });
  }

  return {
    totalPct: totalScorable ? Math.round((100 * totalInTune) / totalScorable) : null,
    scoredS: totalScorable * hopS,
    phrases,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add --all && git commit -m "feat: scoreSession — in-tune-percent frame math, octave modes"
```

---

### Task 3: phrase mapping + total weighting

**Files:**
- Modify: `renderer/tests/score.test.mjs` (implementation already exists; these tests pin the phrase semantics)

- [ ] **Step 1: Write the tests**

Append to `renderer/tests/score.test.mjs`:

```js
test("phrases split on LRC line stamps and score independently", () => {
  const lines = [
    { t: 0, text: "first line" },
    { t: 1, text: "second line" },
  ];
  const buckets = sing(0, 100, 69); // only the first line is sung
  // userMedianS 0: the ±30ms median window would bleed a few sung frames
  // across the phrase boundary; this test pins boundary semantics, not the lever.
  const res = scoreSession({ buckets, ref: flatRef(), lines, durationS: 2, opts: { userMedianS: 0 } });
  assert.equal(res.phrases.length, 2);
  assert.equal(res.phrases[0].pct, 100);
  assert.equal(res.phrases[1].pct, 0);
  assert.equal(res.totalPct, 50);
});

test("instrumental phrase scores null and is excluded from the total", () => {
  const midis = [...Array(100).fill(69), ...Array(100).fill(null)];
  const ref = prepRef(contourFrom(midis), { onsetGateS: 0 });
  const lines = [
    { t: 0, text: "sung line" },
    { t: 1, text: "" }, // instrumental: no reference voicing
  ];
  const res = scoreSession({ buckets: sing(0, 100, 69), ref, lines, durationS: 2 });
  assert.equal(res.phrases[1].pct, null);
  assert.equal(res.totalPct, 100); // null phrase doesn't drag the total
});

test("melody before the first lyric becomes a leading ♪ phrase", () => {
  const lines = [{ t: 1, text: "late line" }];
  const res = scoreSession({ buckets: sing(0, 200, 69), ref: flatRef(), lines, durationS: 2 });
  assert.equal(res.phrases.length, 2);
  assert.equal(res.phrases[0].text, "♪");
  assert.equal(res.phrases[0].pct, 100);
});

test("no leading phrase when the intro has no melody", () => {
  const midis = [...Array(100).fill(null), ...Array(100).fill(69)];
  const ref = prepRef(contourFrom(midis), { onsetGateS: 0 });
  const lines = [{ t: 1, text: "only line" }];
  const res = scoreSession({ buckets: sing(100, 200, 69), ref, lines, durationS: 2 });
  assert.equal(res.phrases.length, 1);
});

test("total is frame-weighted, not a mean of phrase percents", () => {
  const lines = [
    { t: 0, text: "ten frames" },
    { t: 0.1, text: "the rest" },
  ];
  const buckets = sing(0, 10, 69); // only the short phrase in tune
  // userMedianS 0 for the same boundary-bleed reason as the phrase-split test.
  const res = scoreSession({ buckets, ref: flatRef(), lines, durationS: 2, opts: { userMedianS: 0 } });
  assert.equal(res.phrases[0].pct, 100);
  assert.equal(res.phrases[1].pct, 0);
  assert.equal(res.totalPct, 5); // 10/200 — not mean(100, 0) = 50
});
```

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: all PASS (Task 2's implementation covers these). If any fail, fix `scoreSession` — the tests are the contract.

- [ ] **Step 3: Commit**

```bash
git add --all && git commit -m "test: pin phrase mapping + frame-weighted total semantics"
```

---

### Task 4: player integration — run collection + summary overlay

**Files:**
- Modify: `renderer/index.html` (overlay markup)
- Modify: `renderer/style.css` (overlay styles)
- Modify: `renderer/player.mjs` (collection, triggers, rendering)
- Modify: `renderer/app.js` (Back-button hook)

No new unit tests: this task is DOM/glue wiring around the tested core; it is verified end to end by the Task 6 harness run.

- [ ] **Step 1: Add the overlay markup**

In `renderer/index.html`, inside `<div id="view-player">`, after the closing `</footer>` tag (line with `</footer>`), insert:

```html
    <div id="summary" hidden>
      <div class="summary-card">
        <div id="sum-total" class="sum-total"></div>
        <div id="sum-sub" class="sum-sub"></div>
        <div id="sum-phrases"></div>
        <div class="sum-actions">
          <button id="sum-again" class="primary">Sing again</button>
          <button id="sum-done">Done</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Add the overlay styles**

Append to `renderer/style.css`:

```css
/* ---- session summary (Phase 4) ---- */

#summary {
  position: fixed;
  inset: 0;
  background: rgba(16, 16, 20, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.summary-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 26px;
  width: min(560px, 86vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sum-total {
  font-size: 44px;
  font-weight: 700;
  color: var(--ok);
  text-align: center;
}

.sum-sub {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

#sum-phrases {
  overflow-y: auto;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sum-row {
  display: grid;
  grid-template-columns: 1fr 120px 44px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.sum-row.dim { color: var(--muted); opacity: 0.6; }
.sum-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sum-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}
.sum-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--ok);
}

.sum-pct {
  text-align: right;
  font: 13px ui-monospace, "SF Mono", Menlo, monospace;
}

.sum-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 8px;
}
#sum-done {
  background: none;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  padding: 8px 16px;
  cursor: pointer;
}
#sum-done:hover { border-color: var(--muted); }
```

- [ ] **Step 3: Wire the player**

All edits in `renderer/player.mjs`:

3a. Extend the imports (top of file):

```js
import { prepRef, scoreSession, SCORE_OPTS } from "./score.mjs";
```

3b. Add module state next to `let lastVoicedMs = 0;`:

```js
let summaryFromBack = false; // Done returns to library when Back opened the summary
```

3c. In `initPlayer()`, extend the id list with the new elements — replace the existing array with:

```js
  for (const id of ["view-player", "back", "p-title", "p-artist", "p-clock", "lane", "lyrics", "lyrics-empty", "playpause", "mic", "mic-note", "octave", "seek", "summary", "sum-total", "sum-sub", "sum-phrases", "sum-again", "sum-done"]) {
```

3d. In `initPlayer()`, after the `els.seek.addEventListener("pointerup", ...)` line, add:

```js
  els.sumAgain.addEventListener("click", () => {
    dismissSummary();
    if (!state) return;
    state.audio.currentTime = 0;
    state.liveNotes.reset();
    state.audio.play().catch(() => {});
  });
  els.sumDone.addEventListener("click", () => {
    const leave = summaryFromBack;
    dismissSummary();
    if (leave) location.hash = "";
  });
```

3e. In `openPlayer()`, add two fields to the `state` object literal (after `liveNotes: ...`):

```js
    run: new Map(), // frame index → sung midi (raw); the session being scored
    ref: null, // prepRef output; null means no contour, nothing to score
```

3f. In `openPlayer()`, inside the existing `if (contour) { ... }` block, add as the last line:

```js
    state.ref = prepRef(contour);
```

3g. In `openPlayer()`, next to the other `audio.addEventListener` lines, add:

```js
  audio.addEventListener("ended", () => showSummary(false));
```

3h. In `onMicSample()`, immediately after the `state.liveNotes.push(songT, midi);` line, add:

```js
  // Scoring collects the raw register — octave folding is applied at scoring
  // time from the mode toggle, not baked into the buckets.
  if (state.ref) state.run.set(Math.round(songT / state.ref.hopS), hzToMidi(d.f0));
```

3i. Add the summary functions (place after `stopMic()`):

```js
function showSummary(fromBack) {
  if (!state || !state.ref || !state.run.size || !els.summary.hidden) return false;
  state.audio.pause();
  summaryFromBack = fromBack;
  renderSummary(
    scoreSession({
      buckets: state.run,
      ref: state.ref,
      lines: state.lines,
      durationS: state.durationS,
      octaveMode,
    }),
  );
  els.summary.hidden = false;
  return true;
}

// Back-button hook (called from app.js): first Back with a sung run shows
// the verdict instead of leaving; the next Back (or Done) actually leaves.
export function maybeShowSummary() {
  return showSummary(true);
}

function dismissSummary() {
  els.summary.hidden = true;
  summaryFromBack = false;
  if (state) state.run.clear(); // a dismissed score is gone; next sing starts clean
}

function renderSummary(res) {
  els.sumTotal.textContent = res.totalPct === null ? "—" : `${res.totalPct}%`;
  els.sumSub.textContent =
    `${res.scoredS.toFixed(1)}s scored · ${OCTAVE_MODES[octaveMode]} · ±${SCORE_OPTS.tolCents}¢`;
  els.sumPhrases.textContent = "";
  for (const p of res.phrases) {
    const row = document.createElement("div");
    row.className = "sum-row";
    if (p.pct === null) row.classList.add("dim");
    const text = document.createElement("span");
    text.className = "sum-text";
    text.textContent = p.text || "♪";
    const bar = document.createElement("span");
    bar.className = "sum-bar";
    const fill = document.createElement("span");
    fill.className = "sum-fill";
    fill.style.width = `${p.pct ?? 0}%`;
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "sum-pct";
    pct.textContent = p.pct === null ? "—" : `${p.pct}%`;
    row.append(text, bar, pct);
    els.sumPhrases.appendChild(row);
  }
}
```

3j. In `closePlayer()`, after `stopMic();`, add:

```js
  els.summary.hidden = true;
  summaryFromBack = false;
```

- [ ] **Step 4: Hook the Back button in app.js**

In `renderer/app.js`, change the import line to:

```js
import { initPlayer, openPlayer, closePlayer, maybeShowSummary } from "./player.mjs";
```

and replace the back-button listener with:

```js
backBtn.addEventListener("click", () => {
  // A sung run gets its verdict before leaving; second Back actually leaves.
  if (!maybeShowSummary()) location.hash = "";
});
```

- [ ] **Step 5: Run the unit tests (regression only)**

Run: `npm test 2>&1 | tail -5`
Expected: all suites still PASS (player.mjs isn't under unit test; this catches import typos in score.mjs).

- [ ] **Step 6: Commit**

```bash
git add --all && git commit -m "feat: session summary overlay — run collection, ended/Back triggers"
```

---

### Task 5: contour default flips to fast

**Files:**
- Modify: `renderer/index.html:16`
- Modify: `README.md`

- [ ] **Step 1: Default the checkbox on**

In `renderer/index.html`, change:

```html
          <input type="checkbox" id="fast" /> fast
```

to:

```html
          <input type="checkbox" id="fast" checked /> fast
```

- [ ] **Step 2: Update the README**

In `README.md`, replace the sentence:

```
The `fast` toggle uses CREPE-tiny for a quicker, rougher contour.
```

with:

```
The `fast` toggle (default on) uses CREPE-tiny for a quicker, rougher contour — CREPE-full costs ~28 min CPU on a 3-minute song; untick it when you want the best reference.
```

- [ ] **Step 3: Commit**

```bash
git add --all && git commit -m "feat: default the fast contour engine on (first-song UX)"
```

---

### Task 6: headless e2e — fake mic sings the synthetic song, summary asserted

**Files:**
- Modify: `scripts/make_synth_bundle.py`
- Modify: `electron/main.js` (summary probe)
- Modify: `README.md` (harness docs)

- [ ] **Step 1: Add env knobs to the synth bundle**

In `scripts/make_synth_bundle.py`:

1a. Add `import os` to the imports (after `import json`).

1b. Change `DUR = 30.0` to:

```python
DUR = float(os.environ.get("KARAOKE_SYNTH_DUR_S", "30"))
```

1c. After the melody-contour `for k in range(...)` loop (right before the `(ROOT / "contour.json").write_text(...)` call), add:

```python
# Constant-pitch mode: the whole song is one note, so a fixed-frequency fake
# mic (KARAOKE_FAKE_MIC) should score ~100% — the scoring-pipeline e2e check.
const_hz = float(os.environ.get("KARAOKE_SYNTH_CONST_HZ", "0"))
if const_hz:
    f0[:] = const_hz
    conf[:] = 0.95
```

- [ ] **Step 2: Add the summary probe to the harness**

In `electron/main.js`, inside `armScreenshot()`, after the closing brace of the `if (process.env.KARAOKE_FAKE_MIC) { ... }` mic-probe block (after the `console.log("[karaoke-now] mic probe:", probe);` line's enclosing `}`), add:

```js
        if (process.env.KARAOKE_SHOT_SUMMARY_WAIT_MS) {
          // Let the song run to its end so the summary overlay appears.
          await new Promise((r) => setTimeout(r, Number(process.env.KARAOKE_SHOT_SUMMARY_WAIT_MS)));
          const summary = await win.webContents.executeJavaScript(`(() => {
            const el = document.getElementById("summary");
            if (!el || el.hidden) return "no summary";
            return JSON.stringify({
              total: document.getElementById("sum-total").textContent,
              sub: document.getElementById("sum-sub").textContent,
              rows: document.querySelectorAll("#sum-phrases .sum-row").length,
            });
          })()`);
          console.log("[karaoke-now] summary probe:", summary);
        }
```

- [ ] **Step 3: Run the e2e**

```bash
KARAOKE_SYNTH_DUR_S=8 KARAOKE_SYNTH_CONST_HZ=440 \
  sidecar/.venv/bin/python scripts/make_synth_bundle.py
KARAOKE_SONGS_DIR=/tmp/karaoke-test-songs KARAOKE_SHOT_DIR=/tmp/karaoke-shots \
  KARAOKE_SHOT_HASH="#play/deadbeefdeadbeef" KARAOKE_SHOT_PLAY=1 \
  KARAOKE_FAKE_MIC=440 KARAOKE_SHOT_SUMMARY_WAIT_MS=7000 npx electron .
```

Timeline: 1.5s settle → play + mic click → 3s playback probe → 7s wait, song ends at 8s, summary fires → probe logs → screenshot (`/tmp/karaoke-shots/player.png`) captures the overlay.

Expected output lines:
- `[karaoke-now] mic probe:` with `f0Median` ≈ 440
- `[karaoke-now] summary probe:` JSON with `total` ≥ 90% (the few-hundred-ms unsung head before the mic click counts against — that's the design working, not a bug) and `rows` ≥ 4

Also view `/tmp/karaoke-shots/player.png` and confirm the overlay renders: big percent, phrase rows with bars, two buttons.

If the probe prints `no summary`: check that `ended` fired (8s song, ~11.5s total wait), that the bundle is the const-pitch one (regenerate), and that `state.run.size > 0` (mic probe `voiced` should be in the hundreds).

- [ ] **Step 4: Document the knobs**

In `README.md`, in the Dev harness section, after the `KARAOKE_FAKE_MIC=440` comment block, add:

```bash
# Scoring e2e: constant-pitch synth bundle + fake mic at the same frequency
# should land ~100%. KARAOKE_SHOT_SUMMARY_WAIT_MS keeps the window alive past
# the song's end so the summary overlay appears and gets probed + screenshotted.
KARAOKE_SYNTH_DUR_S=8 KARAOKE_SYNTH_CONST_HZ=440 \
  sidecar/.venv/bin/python scripts/make_synth_bundle.py
```

- [ ] **Step 5: Commit**

```bash
git add --all && git commit -m "feat: scoring e2e — const-pitch synth knob + summary probe"
```

---

### Task 7: full verification + roadmap

**Files:**
- Modify: `README.md` (roadmap checkbox)

- [ ] **Step 1: Full test suites**

```bash
npm test 2>&1 | tail -5
cd sidecar && .venv/bin/python -m pytest -q && cd ..
```

Expected: all renderer tests PASS (existing 68 + ~20 new), 18+ sidecar tests PASS.

- [ ] **Step 2: Re-run the standard (melody) harness as regression**

```bash
sidecar/.venv/bin/python scripts/make_synth_bundle.py
KARAOKE_SONGS_DIR=/tmp/karaoke-test-songs KARAOKE_SHOT_DIR=/tmp/karaoke-shots \
  KARAOKE_SHOT_HASH="#play/deadbeefdeadbeef?t=12" KARAOKE_SHOT_PLAY=1 \
  KARAOKE_FAKE_MIC=440 npx electron .
```

Expected: playback probe clock advances, mic probe `f0Median` ≈ 440, no summary probe (knob unset), screenshot fine — Phase 3 behavior unchanged.

- [ ] **Step 3: Tick the roadmap**

In `README.md`, change:

```
- [ ] **Phase 4 — scoring**: in-tune-percent per phrase + session summary
```

to:

```
- [x] **Phase 4 — scoring**: in-tune-percent per phrase + session summary (2026-06-10)
```

- [ ] **Step 4: Commit**

```bash
git add --all && git commit -m "docs: Phase 4 roadmap tick + verification run"
```

---

## After the plan: PR + wiki (session owner, not the executor)

Push `phase-4-scoring`, open a PR with the e2e evidence, then update the Obsidian project page (`Imagineer/_wiki/projects/local-karaoke/local-karaoke.md`): status, log entry, resolve the "what counts as voiced" open question, note the fast-default decision. Regenerate the dashboard. These are deliberately outside the task list — they touch the vault, not this repo.
