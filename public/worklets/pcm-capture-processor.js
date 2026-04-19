// Capture processor for the streaming pipeline. Reads the engine master
// output, interleaves it into stereo f32, and forwards full buffers to the
// renderer main thread via port.postMessage + transfer.
//
// Each message gets its OWN freshly-allocated Float32Array. Reusing a
// single buffer and relying on structured-clone to snapshot at postMessage
// time sounds tempting but empirically isn't safe on the AudioWorklet port —
// the main thread can end up reading a racing buffer mid-overwrite, which
// manifests as garbage f32 values (e.g. ~3.4e+38, the f32 max) and makes
// the LAME bit reservoir blow up downstream.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize * 2);
    this._writePos = 0;
    this._active = false;

    this.port.onmessage = (e) => {
      if (e.data.type === 'set-active') {
        this._active = e.data.active;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // Pass through to output (for downstream analysers etc.). Zero-alloc.
    for (let ch = 0; ch < Math.min(input.length, outputs[0]?.length ?? 0); ch++) {
      outputs[0][ch].set(input[ch]);
    }

    if (!this._active) return true;

    const numFrames = input[0].length;
    const channels = Math.min(input.length, 2);
    const left = input[0];
    const right = channels > 1 ? input[1] : input[0];
    const buf = this._buffer;
    const bufLen = buf.length;
    let w = this._writePos;

    for (let i = 0; i < numFrames; i++) {
      buf[w++] = left[i];
      buf[w++] = right[i];

      if (w >= bufLen) {
        // Transfer-send this buffer to main and start a fresh one. The
        // allocation here is the GC-pressure cost; trying to reuse a
        // single buffer + structured clone corrupts the stream.
        const out = new Float32Array(buf);
        this.port.postMessage({ type: 'pcm', buffer: out }, [out.buffer]);
        w = 0;
      }
    }

    this._writePos = w;
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
