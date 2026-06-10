// Sliding-window accumulator: 128-frame render quanta in, fixed windows out
// every `hop` samples. Pure module — runs in the AudioWorkletGlobalScope and
// under node:test alike. The optional `out` buffer is reused on every emit so
// the audio thread never allocates (it can be a view into WASM memory).

export class Hopper {
  constructor(windowSize, hop, out = null) {
    this.win = windowSize;
    this.hop = hop;
    this.ring = new Float32Array(windowSize);
    this.head = 0; // next write index == oldest sample once full
    this.frames = 0; // total samples ever pushed
    this.sinceHop = 0;
    this.out = out || new Float32Array(windowSize);
  }

  push(block, emit) {
    for (let i = 0; i < block.length; i++) {
      this.ring[this.head] = block[i];
      this.head = (this.head + 1) % this.win;
      this.frames++;
      if (this.frames === this.win) {
        this.sinceHop = 0;
        emit(this.linearize(), this.frames);
      } else if (this.frames > this.win && ++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        emit(this.linearize(), this.frames);
      }
    }
  }

  // Unwrap the ring into out: oldest sample first, newest last.
  linearize() {
    const tail = this.ring.subarray(this.head);
    this.out.set(tail);
    this.out.set(this.ring.subarray(0, this.head), tail.length);
    return this.out;
  }
}
