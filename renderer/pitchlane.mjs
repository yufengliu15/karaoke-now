// Pitch-lane geometry: contour frames → drawable segments + coordinate maps.
// Pure module: no DOM, unit-tested in renderer/tests/.

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

// Running median with a window truncated at the edges. Display-only smoothing:
// kills single-frame octave blips without touching the bundled contour.
export function medianSmooth(values, win) {
  if (win <= 1) return values.slice();
  const half = win >> 1;
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1));
    w.sort((a, b) => a - b);
    return w[w.length >> 1];
  });
}

const SEG_DEFAULTS = { confMin: 0.5, smooth: 5, jumpMidi: 6, minFrames: 2 };

// Voiced runs → polyline segments of {t, midi}. Splits on unvoiced frames,
// low confidence, and adjacent-frame jumps larger than jumpMidi (octave errors).
export function buildSegments(contour, opts = {}) {
  const { confMin, smooth, jumpMidi, minFrames } = { ...SEG_DEFAULTS, ...opts };
  const { f0_hz: f0, confidence: conf, hop_ms } = contour;
  const dt = hop_ms / 1000;

  const runs = [];
  let run = null;
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] > 0 && conf[i] >= confMin) {
      (run ??= []).push(i);
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);

  const segments = [];
  for (const indices of runs) {
    const midis = medianSmooth(indices.map((i) => f0[i]), smooth).map(hzToMidi);
    let seg = [];
    for (let k = 0; k < indices.length; k++) {
      if (seg.length && Math.abs(midis[k] - midis[k - 1]) > jumpMidi) {
        if (seg.length >= minFrames) segments.push(seg);
        seg = [];
      }
      seg.push({ t: indices[k] * dt, midi: midis[k] });
    }
    if (seg.length >= minFrames) segments.push(seg);
  }
  return segments;
}

const RANGE_DEFAULTS = { confMin: 0.5, padSt: 3, minSpan: 18, fallback: { lo: 48, hi: 72 } };

// Y-axis fit: 5th..95th percentile of the voiced contour, padded, never
// narrower than minSpan semitones so sparse contours don't zoom absurdly.
export function fitMidiRange(contour, opts = {}) {
  const { confMin, padSt, minSpan, fallback } = { ...RANGE_DEFAULTS, ...opts };
  const midis = contour.f0_hz
    .filter((hz, i) => hz > 0 && contour.confidence[i] >= confMin)
    .map(hzToMidi)
    .sort((a, b) => a - b);
  if (!midis.length) return { ...fallback };

  const pct = (q) => midis[Math.round((midis.length - 1) * q)];
  let lo = pct(0.05) - padSt;
  let hi = pct(0.95) + padSt;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  return { lo, hi };
}

// The now-line sits at leadFrac of the canvas width; time scrolls right-to-left.
export function timeToX(t, now, { width, windowS, leadFrac = 0.25 }) {
  return ((t - now) / windowS + leadFrac) * width;
}

export function midiToY(midi, { lo, hi, height }) {
  return ((hi - midi) / (hi - lo)) * height;
}
