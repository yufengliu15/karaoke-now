// Mic capture processor: accumulates render quanta, runs YIN-in-WASM every
// hop, posts {f0, clarity, rms, t} to the renderer. All per-hop compute is
// WASM + preallocated buffers — nothing on the audio thread allocates.
//
// `t` is the AudioContext time of the *center* of the analysis window: the
// YIN estimate describes that moment, not the moment the message arrives.
// The wasm bytes come in via processorOptions (compiled synchronously here;
// the module is <1KB) because the worklet scope cannot fetch().

import { Hopper } from "./micbuffer.mjs";

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.windowSize = o.windowSize || 2048;
    this.hop = o.hop || 256;
    this.fMin = o.fMin || 60;
    this.fMax = o.fMax || 1000;
    this.threshold = o.threshold || 0.12;

    const module = new WebAssembly.Module(o.wasmBytes);
    this.yin = new WebAssembly.Instance(module, {}).exports;
    const input = new Float32Array(this.yin.memory.buffer, this.yin.inputPtr(), this.windowSize);
    this.hopper = new Hopper(this.windowSize, this.hop, input);
    this.startFrame = -1;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.startFrame < 0) this.startFrame = currentFrame;

    this.hopper.push(ch, (win, frames) => {
      let sumSq = 0;
      for (let i = 0; i < win.length; i++) sumSq += win[i] * win[i];
      const rms = Math.sqrt(sumSq / win.length);
      const f0 = this.yin.detect(this.windowSize, sampleRate, this.fMin, this.fMax, this.threshold);
      this.port.postMessage({
        f0,
        clarity: this.yin.clarity(),
        rms,
        t: (this.startFrame + frames - this.windowSize / 2) / sampleRate,
      });
    });
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
