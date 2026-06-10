import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hzToMidi,
  medianSmooth,
  buildSegments,
  fitMidiRange,
  timeToX,
  midiToY,
} from "../pitchlane.mjs";

function contour(f0, conf, hop_ms = 10) {
  return { hop_ms, f0_hz: f0, confidence: conf ?? f0.map(() => 1) };
}

test("hzToMidi: A4=69, A3=57", () => {
  assert.equal(hzToMidi(440), 69);
  assert.equal(hzToMidi(220), 57);
});

test("medianSmooth kills single-frame blip, truncated window at edges", () => {
  assert.deepEqual(medianSmooth([10, 10, 100, 10, 10], 3), [10, 10, 10, 10, 10]);
  assert.deepEqual(medianSmooth([5], 5), [5]);
});

test("buildSegments: one voiced run becomes one segment with hop-spaced times", () => {
  const segs = buildSegments(contour([220, 220, 220], [1, 1, 1]));
  assert.equal(segs.length, 1);
  assert.deepEqual(
    segs[0].map((p) => p.t),
    [0, 0.01, 0.02],
  );
  for (const p of segs[0]) assert.ok(Math.abs(p.midi - 57) < 1e-9);
});

test("buildSegments: f0=0 splits segments", () => {
  const segs = buildSegments(contour([220, 220, 0, 220, 220]));
  assert.equal(segs.length, 2);
  assert.equal(segs[0].length, 2);
  assert.equal(segs[1].length, 2);
});

test("buildSegments: low confidence splits segments", () => {
  const segs = buildSegments(contour([220, 220, 220, 220, 220], [1, 1, 0.2, 1, 1]), {
    confMin: 0.5,
  });
  assert.equal(segs.length, 2);
});

test("buildSegments: median smoothing flattens octave blip inside a run", () => {
  const segs = buildSegments(contour([220, 220, 440, 220, 220]), { smooth: 3 });
  assert.equal(segs.length, 1);
  for (const p of segs[0]) assert.ok(Math.abs(p.midi - 57) < 1e-9);
});

test("buildSegments: sustained jump over jumpMidi splits segments", () => {
  const segs = buildSegments(contour([220, 220, 220, 880, 880, 880]), { smooth: 1 });
  assert.equal(segs.length, 2);
});

test("buildSegments: drops segments shorter than 2 frames", () => {
  const segs = buildSegments(contour([220, 0, 0, 220, 220]));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 2);
});

test("fitMidiRange: clamps to minimum span centered on content", () => {
  const r = fitMidiRange(contour([440, 440, 440, 440]));
  assert.deepEqual(r, { lo: 60, hi: 78 });
});

test("fitMidiRange: ignores unvoiced and low-confidence frames", () => {
  const r = fitMidiRange(contour([440, 0, 55], [1, 1, 0.1]));
  assert.deepEqual(r, { lo: 60, hi: 78 });
});

test("fitMidiRange: empty contour falls back to C3..C5", () => {
  const r = fitMidiRange(contour([]));
  assert.deepEqual(r, { lo: 48, hi: 72 });
});

test("timeToX: now-line sits at leadFrac of width", () => {
  const opts = { width: 800, windowS: 8, leadFrac: 0.25 };
  assert.equal(timeToX(10, 10, opts), 200);
  assert.equal(timeToX(10 - 2, 10, opts), 0);
  assert.equal(timeToX(10 + 6, 10, opts), 800);
});

test("midiToY: higher pitch is higher on canvas (smaller y)", () => {
  const opts = { lo: 60, hi: 72, height: 240 };
  assert.equal(midiToY(72, opts), 0);
  assert.equal(midiToY(60, opts), 240);
  assert.equal(midiToY(66, opts), 120);
});

// --- note quantization (buildNotes) ---------------------------------------

import { buildNotes } from "../pitchlane.mjs";

test("buildNotes: steady run becomes one bar at the quantized semitone", () => {
  const notes = buildNotes(contour(Array(50).fill(220)));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].midi, 57);
  assert.equal(notes[0].t0, 0);
  assert.ok(Math.abs(notes[0].t1 - 0.49) < 1e-9);
});

test("buildNotes: vibrato within the semitone collapses into one flat bar", () => {
  // ±40 cents around A3 (220 Hz): frames alternate but all quantize to 57.
  const f0 = Array.from({ length: 60 }, (_, i) => 220 * 2 ** (0.4 * Math.sin(i / 3) / 12));
  const notes = buildNotes(contour(f0));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].midi, 57);
});

test("buildNotes: melody with unvoiced gap becomes separate bars", () => {
  const f0 = [...Array(30).fill(220), ...Array(20).fill(0), ...Array(30).fill(261.63)];
  const notes = buildNotes(contour(f0));
  assert.deepEqual(notes.map((n) => n.midi), [57, 60]);
  assert.ok(notes[1].t0 > notes[0].t1);
});

test("buildNotes: semitone slide inside a run splits into two bars", () => {
  const f0 = [...Array(30).fill(220), ...Array(30).fill(246.94)]; // A3 → B3
  const notes = buildNotes(contour(f0), { smooth: 1 });
  assert.deepEqual(notes.map((n) => n.midi), [57, 59]);
});

test("buildNotes: blips shorter than minNoteS are dropped", () => {
  const f0 = [...Array(30).fill(220), ...Array(3).fill(440), ...Array(30).fill(220)];
  const notes = buildNotes(contour(f0), { smooth: 1, minNoteS: 0.08, mergeGapS: 0 });
  for (const n of notes) assert.equal(n.midi, 57);
});

test("buildNotes: same note across a tiny gap merges into one bar", () => {
  const f0 = [...Array(30).fill(220), ...Array(4).fill(0), ...Array(30).fill(220)];
  const notes = buildNotes(contour(f0), { mergeGapS: 0.06 });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].midi, 57);
  assert.ok(notes[0].t1 > 0.6);
});

test("buildNotes: low-confidence frames are unvoiced", () => {
  const f0 = Array(40).fill(220);
  const conf = f0.map((_, i) => (i < 20 ? 0.9 : 0.1));
  const notes = buildNotes(contour(f0, conf), { mergeGapS: 0 });
  assert.equal(notes.length, 1);
  assert.ok(notes[0].t1 <= 0.2 + 1e-9);
});

// --- live user trace (Phase 3) ---------------------------------------------

import { foldMidiToRange } from "../pitchlane.mjs";

test("foldMidiToRange: in-range pitch passes through untouched", () => {
  assert.equal(foldMidiToRange(64.3, 55, 79), 64.3);
});

test("foldMidiToRange: octave-down singing folds up into the lane", () => {
  // Reference lane around C4..C5, singer an octave below.
  assert.equal(foldMidiToRange(48.5, 60, 84), 60.5);
  assert.equal(foldMidiToRange(36.5, 60, 84), 60.5);
});

test("foldMidiToRange: octave-up folds down", () => {
  assert.equal(foldMidiToRange(91, 60, 84), 79);
});

test("foldMidiToRange: narrow lane (span < octave) clamps after best fold", () => {
  const v = foldMidiToRange(50, 60, 66);
  assert.ok(v >= 60 && v <= 66, `got ${v}`);
});





