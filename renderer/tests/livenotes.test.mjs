// LiveNoteTracker: the causal cousin of buildNotes — live mic estimates in,
// stable semitone note bars out, no lookahead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveNoteTracker } from "../livenotes.mjs";

const HOP = 0.005; // ~256 samples at 48k

// Feed fn(t)→midi (or constant) from t0 to t1 at hop spacing.
function feed(tracker, t0, t1, midi) {
  for (let t = t0; t < t1; t += HOP) {
    tracker.push(t, typeof midi === "function" ? midi(t) : midi);
  }
}

test("steady pitch becomes one bar at the quantized semitone", () => {
  const tr = new LiveNoteTracker();
  feed(tr, 0, 0.3, 60.2);
  const bars = tr.bars();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].midi, 60);
  assert.ok(bars[0].t0 < 0.01, `t0 ${bars[0].t0}`); // backdated to onset
  assert.ok(bars[0].t1 > 0.29, `t1 ${bars[0].t1}`);
});

test("no bar until the onset window proves the note is real", () => {
  const tr = new LiveNoteTracker({ onsetS: 0.06 });
  feed(tr, 0, 0.03, 60);
  assert.equal(tr.bars().length, 0);
  feed(tr, 0.03, 0.1, 60);
  assert.equal(tr.bars().length, 1);
});

test("vibrato inside the semitone stays one flat bar", () => {
  const tr = new LiveNoteTracker();
  feed(tr, 0, 0.5, (t) => 60 + 0.45 * Math.sin(2 * Math.PI * 6 * t));
  const bars = tr.bars();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].midi, 60);
});

test("sustained move to a new semitone closes the bar and opens another", () => {
  const tr = new LiveNoteTracker();
  feed(tr, 0, 0.2, 60);
  feed(tr, 0.2, 0.5, 64);
  const bars = tr.bars();
  assert.deepEqual(bars.map((b) => b.midi), [60, 64]);
  // Switch is backdated to when the new note actually started, give or take
  // the median window catching up.
  assert.ok(Math.abs(bars[1].t0 - 0.2) < 0.08, `t0 ${bars[1].t0}`);
  assert.ok(bars[0].t1 <= bars[1].t0 + 1e-9);
});

test("a blip shorter than the switch window is absorbed", () => {
  const tr = new LiveNoteTracker({ switchS: 0.08 });
  feed(tr, 0, 0.2, 60);
  feed(tr, 0.2, 0.23, 64); // 30ms wobble
  feed(tr, 0.23, 0.4, 60);
  const bars = tr.bars();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].midi, 60);
  assert.ok(bars[0].t1 > 0.39);
});

test("one octave-error sample cannot move the median", () => {
  const tr = new LiveNoteTracker();
  feed(tr, 0, 0.2, 60);
  tr.push(0.2, 72);
  feed(tr, 0.205, 0.4, 60);
  const bars = tr.bars();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].midi, 60);
});

test("a breath gap closes the bar; the next note is separate", () => {
  const tr = new LiveNoteTracker({ gapS: 0.25 });
  feed(tr, 0, 0.2, 60);
  feed(tr, 0.6, 0.8, 62);
  const bars = tr.bars();
  assert.deepEqual(bars.map((b) => b.midi), [60, 62]);
  assert.ok(bars[0].t1 < 0.25);
  assert.ok(bars[1].t0 > 0.55);
});

test("note() reports the held semitone, null when nothing is held", () => {
  const tr = new LiveNoteTracker();
  assert.equal(tr.note(), null);
  feed(tr, 0, 0.2, 65.4);
  assert.equal(tr.note(), 65);
});

test("bars older than keepS are pruned", () => {
  const tr = new LiveNoteTracker({ keepS: 1, gapS: 0.1 });
  feed(tr, 0, 0.2, 60);
  feed(tr, 0.5, 0.7, 62);
  feed(tr, 5, 5.2, 64);
  const bars = tr.bars();
  assert.deepEqual(bars.map((b) => b.midi), [64]);
});

test("reset() clears bars and held note", () => {
  const tr = new LiveNoteTracker();
  feed(tr, 0, 0.3, 60);
  tr.reset();
  assert.equal(tr.bars().length, 0);
  assert.equal(tr.note(), null);
});
