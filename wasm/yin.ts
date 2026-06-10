// YIN pitch detector (de Cheveigné & Kawahara 2002), compiled to WASM so the
// AudioWorklet's per-hop compute is deterministic — no JS GC pauses inside the
// audio callback. Raw load/store on static memory; no runtime, no allocations.
//
// Protocol: JS writes up to MAX_N f32 samples at inputPtr(), calls
// detect(n, sampleRate, fMin, fMax, threshold) → f0 in Hz (0 = no estimate),
// then reads clarity() — 1 minus the CMNDF minimum, ~1 on clean voice,
// low on noise/silence. Voicing gates (clarity, RMS) live in JS.

const MAX_N: i32 = 4096;

const INPUT: usize = memory.data(MAX_N * 4, 8);
const DIFF: usize = memory.data((MAX_N / 2) * 4, 8);

let lastClarity: f32 = 0;

export function inputPtr(): i32 {
  return <i32>INPUT;
}

export function maxInput(): i32 {
  return MAX_N;
}

export function clarity(): f32 {
  return lastClarity;
}

@inline
function x(i: i32): f32 {
  return load<f32>(INPUT + ((<usize>i) << 2));
}

@inline
function d(tau: i32): f32 {
  return load<f32>(DIFF + ((<usize>tau) << 2));
}

@inline
function setD(tau: i32, v: f32): void {
  store<f32>(DIFF + ((<usize>tau) << 2), v);
}

export function detect(n: i32, sampleRate: f32, fMin: f32, fMax: f32, threshold: f32): f32 {
  lastClarity = 0;
  if (n < 64 || n > MAX_N) return 0;

  const w: i32 = n / 2; // integration window; x[i + tau] stays inside n
  let tauMax: i32 = <i32>Math.ceil(sampleRate / fMin);
  if (tauMax > w - 1) tauMax = w - 1;
  let tauMin: i32 = <i32>Math.floor(sampleRate / fMax);
  if (tauMin < 2) tauMin = 2;
  if (tauMin >= tauMax) return 0;

  // Difference function d(tau) = Σ_i (x[i] - x[i+tau])², i in [0, w).
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum: f64 = 0;
    for (let i = 0; i < w; i++) {
      const delta: f64 = <f64>x(i) - <f64>x(i + tau);
      sum += delta * delta;
    }
    setD(tau, <f32>sum);
  }

  // Cumulative-mean-normalized difference, in place:
  // d'(tau) = d(tau) * tau / Σ_{j≤tau} d(j). Silence → tiny cumsum → bail.
  let cumsum: f64 = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    cumsum += <f64>d(tau);
    setD(tau, cumsum > 1e-12 ? <f32>((<f64>d(tau)) * <f64>tau / cumsum) : 1.0);
  }
  if (cumsum <= 1e-12) return 0;

  // Absolute threshold: first dip below it wins (then slide to its local
  // minimum); fall back to the global minimum when nothing dips that far.
  let tauBest: i32 = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d(tau) < threshold) {
      while (tau + 1 <= tauMax && d(tau + 1) < d(tau)) tau++;
      tauBest = tau;
      break;
    }
  }
  if (tauBest < 0) {
    let best: f32 = f32.MAX_VALUE;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d(tau) < best) {
        best = d(tau);
        tauBest = tau;
      }
    }
  }
  if (tauBest < 0) return 0;

  let dpBest: f32 = d(tauBest);

  // Parabolic interpolation around the minimum for sub-sample period.
  let tauRefined: f64 = <f64>tauBest;
  if (tauBest > tauMin && tauBest < tauMax) {
    const a: f64 = <f64>d(tauBest - 1);
    const b: f64 = <f64>d(tauBest);
    const c: f64 = <f64>d(tauBest + 1);
    const denom: f64 = a - 2.0 * b + c;
    if (Math.abs(denom) > 1e-12) {
      let shift: f64 = (a - c) / (2.0 * denom);
      if (shift > 0.5) shift = 0.5;
      if (shift < -0.5) shift = -0.5;
      tauRefined = <f64>tauBest + shift;
      const interp: f64 = b - 0.25 * (a - c) * shift;
      if (interp >= 0 && interp < <f64>dpBest) dpBest = <f32>interp;
    }
  }

  let cl: f32 = 1.0 - dpBest;
  if (cl < 0) cl = 0;
  if (cl > 1) cl = 1;
  lastClarity = cl;

  return <f32>(<f64>sampleRate / tauRefined);
}
