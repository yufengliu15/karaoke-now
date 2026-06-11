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

test("no lyrics → a single phrase spans the whole song", () => {
  const res = scoreSession(flatArgs(sing(0, 200, 69)));
  assert.equal(res.phrases.length, 1);
  assert.equal(res.phrases[0].t0, 0);
  assert.equal(res.phrases[0].t1, 2);
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
