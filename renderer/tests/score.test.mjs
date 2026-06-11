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
