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

// buckets: Map(frame index → sung midi, raw/unfolded), collected by the
// player during a run. Later writes overwrite earlier ones, so re-singing a
// section after a seek rescores it. Score = in-tune / scorable: frames the
// reference sings but the user doesn't count against the percent.
export function scoreSession({ buckets, ref, lines = [], durationS, octaveMode = "any", opts = {} }) {
  const o = { ...ref.opts, ...opts };
  const { refMidi, scorable, hopS } = ref;
  const n = refMidi.length;
  const half = Math.max(0, Math.round(o.userMedianS / hopS));

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
