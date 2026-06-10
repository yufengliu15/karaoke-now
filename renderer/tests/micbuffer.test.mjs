// Hopper: sliding-window accumulator feeding YIN inside the worklet.
import test from "node:test";
import assert from "node:assert/strict";
import { Hopper } from "../worklet/micbuffer.mjs";

function pushBlocks(hopper, total, blockSize = 128) {
  // Samples are their own global index, so window contents are checkable.
  const emitted = [];
  let n = 0;
  while (n < total) {
    const block = Float32Array.from({ length: Math.min(blockSize, total - n) }, (_, i) => n + i);
    hopper.push(block, (win, frames) => emitted.push({ win: Float32Array.from(win), frames }));
    n += block.length;
  }
  return emitted;
}

test("no emission until the window is full", () => {
  const h = new Hopper(512, 128);
  const emitted = pushBlocks(h, 511);
  assert.equal(emitted.length, 0);
});

test("first window emits exactly at windowSize samples", () => {
  const h = new Hopper(512, 128);
  const emitted = pushBlocks(h, 512);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].frames, 512);
  assert.equal(emitted[0].win.length, 512);
  assert.equal(emitted[0].win[0], 0);
  assert.equal(emitted[0].win[511], 511);
});

test("subsequent emissions every hop, window slides correctly", () => {
  const h = new Hopper(512, 128);
  const emitted = pushBlocks(h, 512 + 128 * 3);
  assert.equal(emitted.length, 4);
  const last = emitted[3];
  assert.equal(last.frames, 512 + 384);
  // Window holds the most recent 512 samples ending at frames.
  assert.equal(last.win[0], last.frames - 512);
  assert.equal(last.win[511], last.frames - 1);
});

test("hop not aligned to block size still lands on exact frame counts", () => {
  const h = new Hopper(256, 100);
  const emitted = pushBlocks(h, 1000, 128);
  // Full at 256, then every 100: 256, 356, 456, ..., 956 → 8 emissions.
  assert.equal(emitted.length, 8);
  assert.deepEqual(
    emitted.map((e) => e.frames),
    [256, 356, 456, 556, 656, 756, 856, 956],
  );
  for (const e of emitted) {
    assert.equal(e.win[0], e.frames - 256);
    assert.equal(e.win[255], e.frames - 1);
  }
});

test("emit reuses the provided out buffer (no per-hop allocation)", () => {
  const out = new Float32Array(512);
  const h = new Hopper(512, 512, out);
  let seen = null;
  h.push(Float32Array.from({ length: 512 }, (_, i) => i), (win) => (seen = win));
  assert.equal(seen, out);
  assert.equal(out[511], 511);
});
