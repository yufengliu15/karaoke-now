# Phase 4 — Scoring + Session Summary (Design)

Date: 2026-06-10
Status: approved (UI: summary-only; contour: fast default; persistence: ephemeral; architecture: collect + batch-score)

## Goal

MVP exit criterion: pick a song, sing it, get an honest percent. In-tune-percent
per phrase (phrase = LRC line) plus a session summary screen. No score display
while singing — the live pitch lane remains the only in-song feedback
(pitch-graph-as-instrument decision). Nothing persists to disk.

## Decisions made in brainstorming

1. **Summary only.** No per-phrase flashes or running percent during the song.
   Summary appears at song end (or on Back, if anything was scored).
2. **Contour default flips to fast.** The Electron "fast" toggle (CREPE-tiny)
   defaults ON; CLI flags unchanged. First-song UX beats contour polish;
   scoring's smoothing + confidence gates absorb tiny-model noise.
3. **Ephemeral scores.** Summary lives until dismissed or a new run starts.
   No files written. History is post-MVP.
4. **Architecture: collect during singing, batch-score at end.** Raw mic
   estimates are bucketed per 10ms frame during the run; one pure function
   computes everything when the run ends. No streaming accumulator (nothing
   displays live), no scoring off LiveNoteTracker bars (those are
   display-quantized; scoring keeps raw cents — Phase 2 precedent).

## Scoring math (from the project page's working proposal, unchanged)

A frame is **scorable** when the reference is voiced: `f0_hz > 0` and median-
smoothed confidence ≥ 0.5, minus an onset gate (first 80ms after each
reference note onset — everyone scoops into notes; onsets = voiced-run starts
plus semitone switches on the smoothed contour).

A scorable frame is **in-tune** when the user has a voiced estimate there
(clarity ≥ 0.6, RMS ≥ 0.005 — the gates already applied in `onMicSample`) and
the cents difference ≤ 50, where:

- user f0 at a frame = median over user buckets within ±30ms (vibrato judged
  at its center; the ±50¢ band then absorbs normal vibrato)
- **any-octave mode** (default): cents diff folded to pitch class, i.e. into
  (-600, +600] — octave-down singing counts
- **exact-octave mode**: absolute cents diff — register matters
- mode read from the existing octave toggle at scoring time

**Score = in-tune frames / scorable frames.** Not singing counts against you.
A phrase with zero scorable frames (instrumental line) scores `null`,
displayed as "—", excluded from the total. No lyrics → the whole song is one
phrase. Total = in-tune / scorable over all frames (not a mean of phrase
percents, so short phrases don't distort).

All fairness levers live in one `opts` object with these defaults:
`tolCents: 50, refConfMin: 0.5, onsetGateS: 0.08, userMedianS: 0.06,`
`refSmooth: 5 (frames), clarityMin / rmsFloor (player-owned)`. Calibration is
taste — tuned by singing after merge, not by math now.

## Components

### `renderer/score.mjs` (new, pure, no DOM)

- `prepRef(contour, opts)` → `{ scorable: Uint8Array, refMidi: Float64Array,
  hopS }` — computed once per song load. Median-smoothed f0 → midi, voicing
  mask with confidence gate, onset gate already subtracted from `scorable`.
- `scoreSession({ buckets, ref, lines, durationS, octaveMode, opts })` →
  `{ totalPct, scoredS, phrases: [{ text, t0, t1, pct, scorableS }] }`.
  Phrase boundaries from `lines[i].t .. lines[i+1].t` (last line ends at
  `durationS`); frames before the first line belong to a leading "♪" phrase
  only if scorable frames exist there.

### Run collection (player.mjs)

- `state.run = new Map()` — frame index `round(songT / hopS)` → user midi
  (raw, unquantized; folded only at scoring time, not at collection).
  `onMicSample` writes it next to the existing `liveNotes.push` (audio path
  cost: one Map.set). Later samples overwrite earlier → seeking back and
  re-singing rescores those frames honestly.
- Run resets on `openPlayer` and on any summary dismissal (both "Sing again"
  and "Done") — a dismissed score is gone, the next sing starts clean.
- Summary triggers: `audio.ended`, or Back-button when `state.run.size > 0`.
  Back shows the overlay first; second Back (or Done) actually leaves.

### Summary overlay (player view, plain HTML/CSS)

- Big total percent, subtitle with scored time / octave mode / ±50¢.
- Per-phrase rows: lyric text, percent, thin horizontal bar; "—" rows for
  instrumental lines.
- Buttons: **Sing again** (seek 0, reset run, play) and **Done** (dismiss; if
  reached via Back, returns to library).

### Contour default flip

`renderer/index.html`: `#fast` checkbox gets `checked`. README sentence
updated. Sidecar CLI untouched.

## Error handling

- No contour → mic still draws (existing behavior) but scoring is impossible:
  summary never triggers, no run is collected.
- Mic never turned on / nothing voiced → `run.size === 0` → no summary on
  ended, Back leaves directly.
- Seek wipes nothing: buckets are keyed by song time, overwrite semantics
  handle re-sings; LiveNoteTracker reset on seek is unchanged (display only).

## Testing

TDD, `node:test`, same style as existing suites. `renderer/tests/score.test.mjs`:

- perfect unison → 100; constant +100¢ → 0; half in tune → ≈50
- octave-down: 100 in any-mode, 0 in exact-mode
- silence / nothing sung → 0 (scorable frames exist, none in tune)
- instrumental phrase → pct null, excluded from total
- onset gate: first 80ms of a note excluded from scorable
- vibrato ±60¢ at 6Hz around the reference → ≈100 after 60ms median
- low-confidence reference frames excluded from scorable
- no lyrics → single phrase covering the song
- overwrite: re-pushed frame replaces, doesn't double-count
- total ≠ mean of phrase pcts (weighted by scorable frames)

Headless e2e (existing harness): synthetic bundle at 440 Hz + 
`KARAOKE_FAKE_MIC=440` + `KARAOKE_SHOT_PLAY=1`, song runs to `ended` → probe
logs the summary DOM (harness convention: probes log, the operator asserts;
expected total ≥ 90%); screenshot shows the overlay.

## Out of scope

Score persistence/history, live score display, per-word scoring, difficulty
modes, tolerance auto-calibration, redo-at-full-quality pipeline path
(post-MVP, noted in README roadmap).
