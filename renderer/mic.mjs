// Mic engine: getUserMedia → AudioWorklet (YIN-in-WASM) → onSample callback.
// Owns the AudioContext lifecycle. Fake-mic mode swaps the mic for an
// oscillator so the headless harness can exercise the whole pipeline.

const DEFAULTS = { windowSize: 2048, hop: 256, fMin: 60, fMax: 1000, threshold: 0.12 };

export async function startMic({ onSample, fakeHz = 0, ...rest } = {}) {
  const opts = { ...DEFAULTS, ...rest };
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const wasmBytes = await (await fetch("/worklet/yin.wasm")).arrayBuffer();
  await ctx.audioWorklet.addModule("/worklet/mic-worklet.js");

  let stream = null;
  let source;
  if (fakeHz) {
    source = new OscillatorNode(ctx, { frequency: fakeHz, type: "sine" });
    source.start();
  } else {
    // Raw signal: voice processing (echo cancellation, AGC) mangles singing.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    source = ctx.createMediaStreamSource(stream);
  }

  const node = new AudioWorkletNode(ctx, "mic-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { ...opts, wasmBytes },
  });
  node.port.onmessage = (e) => onSample(e.data);
  source.connect(node);
  node.connect(ctx.destination); // output is silent; connection keeps the node pulled
  await ctx.resume();

  return {
    ctx,
    // Worst-case mic-to-estimate delay (input latency + one hop), for the HUD.
    latencyMs: Math.round(((ctx.baseLatency || 0) + opts.hop / ctx.sampleRate) * 1000),
    stop() {
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {}
      if (stream) for (const track of stream.getTracks()) track.stop();
      ctx.close().catch(() => {});
    },
  };
}
