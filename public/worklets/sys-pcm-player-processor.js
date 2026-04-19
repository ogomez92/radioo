// Plays f32 stereo interleaved PCM received over port.postMessage as an audio
// source inside the Web Audio graph. Each instance serves a single external
// capture source; multiple instances connect to the same destination for mixing.
//
// Expected input payload: { type: 'pcm', buffer: ArrayBuffer }
// Interpreted as interleaved little-endian f32 stereo at the context's sample rate.

const CHANNELS = 2;
const RING_FRAMES = 48000; // 1 s of ring (per channel)

// Don't start playing until we have this much queued. Absorbs IPC jitter
// so we don't glitch the instant the first chunk lands.
const PREBUFFER_FRAMES = 4800; // 100 ms @ 48 kHz

// If we underrun, wait until we've re-buffered this much before resuming.
// A little less than the initial prebuffer so short hiccups recover fast.
const REBUFFER_FRAMES = 2400; // 50 ms @ 48 kHz

class SysPcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = [new Float32Array(RING_FRAMES), new Float32Array(RING_FRAMES)];
    this._readPos = 0;
    this._writePos = 0;
    this._available = 0;
    // "Playing" = we're actively draining the ring. We flip to false on
    // underrun and back to true once the prebuffer target is hit again.
    this._playing = false;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'pcm' && data.buffer instanceof ArrayBuffer) {
        this._push(new Float32Array(data.buffer));
      } else if (data.type === 'flush') {
        this._readPos = 0;
        this._writePos = 0;
        this._available = 0;
        this._playing = false;
      }
    };
  }

  _push(interleaved) {
    const frames = (interleaved.length / CHANNELS) | 0;
    if (frames <= 0) return;

    const overflow = (this._available + frames) - RING_FRAMES;
    if (overflow > 0) {
      this._readPos = (this._readPos + overflow) % RING_FRAMES;
      this._available -= overflow;
    }

    let w = this._writePos;
    for (let i = 0; i < frames; i++) {
      const base = i * CHANNELS;
      this._ring[0][w] = interleaved[base];
      this._ring[1][w] = interleaved[base + 1];
      w++;
      if (w >= RING_FRAMES) w = 0;
    }
    this._writePos = w;
    this._available += frames;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : null;
    const n = outL.length;

    // Not yet draining — stay silent until we've buffered enough. Prevents
    // the "play one chunk then click-silence-click" pattern at startup.
    if (!this._playing) {
      const target = this._hasPlayed ? REBUFFER_FRAMES : PREBUFFER_FRAMES;
      if (this._available < target) {
        outL.fill(0);
        if (outR) outR.fill(0);
        return true;
      }
      if (!this._hasPlayed) {
        this.port.postMessage({ type: 'playing' });
      }
      this._playing = true;
      this._hasPlayed = true;
    }

    // True underrun mid-playback — stop, fill silence, wait for rebuffer.
    if (this._available <= 0) {
      this._playing = false;
      outL.fill(0);
      if (outR) outR.fill(0);
      return true;
    }

    const consume = Math.min(n, this._available);
    let r = this._readPos;
    for (let i = 0; i < consume; i++) {
      outL[i] = this._ring[0][r];
      if (outR) outR[i] = this._ring[1][r];
      r++;
      if (r >= RING_FRAMES) r = 0;
    }
    this._readPos = r;
    this._available -= consume;

    // Partial fill: we ran the ring dry this quantum. Mark underrun so the
    // next process() tick re-buffers instead of stuttering forward.
    if (consume < n) {
      for (let i = consume; i < n; i++) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
      this._playing = false;
    }

    return true;
  }
}

registerProcessor('sys-pcm-player-processor', SysPcmPlayerProcessor);
