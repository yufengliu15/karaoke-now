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
