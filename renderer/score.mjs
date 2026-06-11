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
