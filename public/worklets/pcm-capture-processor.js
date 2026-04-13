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

    // Always pass through to output for monitoring
    for (let ch = 0; ch < Math.min(input.length, outputs[0]?.length ?? 0); ch++) {
      outputs[0][ch].set(input[ch]);
    }

    if (!this._active) return true;

    const numFrames = input[0].length;
    const channels = Math.min(input.length, 2);

    for (let i = 0; i < numFrames; i++) {
      this._buffer[this._writePos++] = input[0][i];
      this._buffer[this._writePos++] = channels > 1 ? input[1][i] : input[0][i];

      if (this._writePos >= this._buffer.length) {
        const copy = new Float32Array(this._buffer);
        this.port.postMessage({ type: 'pcm', buffer: copy }, [copy.buffer]);
        this._buffer = new Float32Array(this._bufferSize * 2);
        this._writePos = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
