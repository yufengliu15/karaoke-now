// Causal note tracker: live mic estimates → stable semitone note bars, the
// real-time cousin of buildNotes (pitchlane.mjs). Same idea — a sung syllable
// reads as one held note — but with no lookahead: a short median window eats
// single-frame errors, onset/switch hysteresis eats vibrato and scoops, and
// the start of each bar is backdated to when the note actually began.
// Pure module: no DOM, unit-tested.

const DEFAULTS = {
  medianS: 0.05, // median window over raw estimates
  onsetS: 0.06, // a note must hold this long before a bar appears
  switchS: 0.08, // a new semitone must hold this long to replace the current
  gapS: 0.25, // silence longer than this closes the bar
  keepS: 12, // completed bars older than this are pruned
};

export class LiveNoteTracker {
  constructor(opts = {}) {
    Object.assign(this, DEFAULTS, opts);
    this.reset();
  }

  reset() {
    this.window = []; // recent {t, midi} inside medianS
    this.current = null; // open bar {t0, t1, midi}
    this.pending = null; // {midi, since} — onset or switch candidate
    this.lastT = -Infinity;
    this.done = []; // completed bars
  }

  push(t, midi) {
    if (t - this.lastT > this.gapS) {
      this._close();
      this.window.length = 0;
      this.pending = null;
    }
    this.lastT = t;
    const cutoff = t - this.keepS;
    while (this.done.length && this.done[0].t1 < cutoff) this.done.shift();

    this.window.push({ t, midi });
    while (this.window[0].t < t - this.medianS) this.window.shift();
    const sorted = this.window.map((s) => s.midi).sort((a, b) => a - b);
    const q = Math.round(sorted[sorted.length >> 1]);

    if (this.current && q === this.current.midi) {
      this.current.t1 = t;
      this.pending = null;
      return;
    }
    if (!this.pending || this.pending.midi !== q) this.pending = { midi: q, since: t };

    const holdS = this.current ? this.switchS : this.onsetS;
    if (t - this.pending.since >= holdS) {
      this._close(this.pending.since);
      this.current = { t0: this.pending.since, t1: t, midi: q };
      this.pending = null;
    }
  }

  _close(at) {
    if (!this.current) return;
    if (at !== undefined && at < this.current.t1) this.current.t1 = at;
    this.done.push(this.current);
    this.current = null;
  }

  bars() {
    return this.current ? [...this.done, this.current] : this.done.slice();
  }

  note() {
    return this.current ? this.current.midi : null;
  }
}
