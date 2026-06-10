// YIN WASM kernel: accuracy on known tones, honesty on noise and silence.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../worklet/yin.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const yin = instance.exports;

const N = 2048;
const DEFAULTS = { fMin: 60, fMax: 1000, threshold: 0.12 };

function detect(samples, sampleRate, opts = {}) {
  const { fMin, fMax, threshold } = { ...DEFAULTS, ...opts };
  new Float32Array(yin.memory.buffer, yin.inputPtr(), samples.length).set(samples);
  const f0 = yin.detect(samples.length, sampleRate, fMin, fMax, threshold);
  return { f0, clarity: yin.clarity() };
}

function sine(freq, sr, n = N, amp = 0.6) {
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr));
}

// Deterministic PRNG so the noise test can't flake.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (a, b) => 1200 * Math.log2(a / b);

test("440 Hz sine at 44.1k: within 3 cents, high clarity", () => {
  const { f0, clarity } = detect(sine(440, 44100), 44100);
  assert.ok(Math.abs(cents(f0, 440)) < 3, `got ${f0} Hz`);
  assert.ok(clarity > 0.95, `clarity ${clarity}`);
});

test("110 Hz sine at 48k: low male range resolves", () => {
  const { f0, clarity } = detect(sine(110, 48000), 48000);
  assert.ok(Math.abs(cents(f0, 110)) < 3, `got ${f0} Hz`);
  assert.ok(clarity > 0.95, `clarity ${clarity}`);
});

test("880 Hz sine at 48k: top of the singing range", () => {
  const { f0 } = detect(sine(880, 48000), 48000);
  assert.ok(Math.abs(cents(f0, 880)) < 4, `got ${f0} Hz`);
});

test("harmonic-rich 196 Hz: fundamental wins, no octave error", () => {
  const sr = 44100;
  const tone = new Float32Array(N);
  for (let h = 1; h <= 6; h++) {
    for (let i = 0; i < N; i++) tone[i] += (0.5 / h) * Math.sin((2 * Math.PI * 196 * h * i) / sr);
  }
  const { f0 } = detect(tone, sr);
  assert.ok(Math.abs(cents(f0, 196)) < 10, `got ${f0} Hz (octave error?)`);
});

test("quiet sine still detected (YIN is amplitude-invariant)", () => {
  const { f0, clarity } = detect(sine(330, 44100, N, 0.02), 44100);
  assert.ok(Math.abs(cents(f0, 330)) < 5, `got ${f0} Hz`);
  assert.ok(clarity > 0.9, `clarity ${clarity}`);
});

test("silence: no estimate, zero clarity", () => {
  const { f0, clarity } = detect(new Float32Array(N), 44100);
  assert.equal(f0, 0);
  assert.equal(clarity, 0);
});

test("white noise: clarity stays below the voicing gate", () => {
  const rand = mulberry32(1234);
  const noise = Float32Array.from({ length: N }, () => rand() * 2 - 1);
  const { clarity } = detect(noise, 44100);
  assert.ok(clarity < 0.7, `clarity ${clarity}`);
});

test("vibrato sine (±50 cents, 6 Hz): estimate lands inside the wobble", () => {
  const sr = 44100;
  const tone = new Float32Array(N);
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const f = 440 * 2 ** ((0.5 * Math.sin((2 * Math.PI * 6 * i) / sr)) / 12);
    phase += (2 * Math.PI * f) / sr;
    tone[i] = 0.6 * Math.sin(phase);
  }
  const { f0, clarity } = detect(tone, sr);
  assert.ok(Math.abs(cents(f0, 440)) < 60, `got ${f0} Hz`);
  assert.ok(clarity > 0.8, `clarity ${clarity}`);
});

test("out-of-range request: f0 above fMax not reported as such", () => {
  // 1500 Hz sine with fMax=1000: detector must not return ~1500.
  const { f0 } = detect(sine(1500, 44100), 44100);
  assert.ok(f0 < 1100, `got ${f0} Hz`);
});
