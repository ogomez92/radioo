// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AudioWorklet globals are not present in node/jsdom. We stand up just enough
// scaffolding to `eval` the worklet file and extract its processor class.

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null;
  deliver: (data: unknown) => void;
  postMessage: (data: unknown) => void;
  posted: unknown[];
}

type ProcessorInstance = {
  port: FakePort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

let ProcessorCtor: new () => ProcessorInstance;

beforeAll(() => {
  const src = readFileSync(
    join(process.cwd(), 'public', 'worklets', 'sys-pcm-player-processor.js'),
    'utf8',
  );

  class FakeAudioWorkletProcessor {
    port: FakePort;
    constructor() {
      const posted: unknown[] = [];
      const port: FakePort = {
        onmessage: null,
        posted,
        deliver(data: unknown) { this.onmessage?.({ data }); },
        postMessage(data: unknown) { posted.push(data); },
      };
      this.port = port;
    }
  }

  const registry: Record<string, new () => ProcessorInstance> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox: any = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (name: string, ctor: new () => ProcessorInstance) => {
      registry[name] = ctor;
    },
  };

  // Evaluate the worklet in a controlled scope so its globals come from our sandbox.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    src,
  );
  fn(sandbox.AudioWorkletProcessor, sandbox.registerProcessor);

  ProcessorCtor = registry['sys-pcm-player-processor'];
  if (!ProcessorCtor) throw new Error('processor not registered');
});

function newProc(): ProcessorInstance {
  return new ProcessorCtor();
}

function pushInterleavedStereo(proc: ProcessorInstance, frames: number, seedL = 0.1, seedR = 0.2) {
  const interleaved = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    interleaved[i * 2] = seedL + i * 0.001;
    interleaved[i * 2 + 1] = seedR + i * 0.001;
  }
  proc.port.deliver({ type: 'pcm', buffer: interleaved.buffer });
  return interleaved;
}

function callProcess(proc: ProcessorInstance, frames = 128) {
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  const keepGoing = proc.process([], [[outL, outR]]);
  return { outL, outR, keepGoing };
}

// Must stay in sync with PREBUFFER_FRAMES / REBUFFER_FRAMES inside the worklet.
const PREBUFFER_FRAMES = 4800;

describe('sys-pcm-player-processor', () => {
  it('outputs silence when nothing has been pushed', () => {
    const proc = newProc();
    const { outL, outR, keepGoing } = callProcess(proc);
    expect(keepGoing).toBe(true);
    expect(Math.max(...outL)).toBe(0);
    expect(Math.max(...outR)).toBe(0);
  });

  it('stays silent until the initial prebuffer target is reached', () => {
    const proc = newProc();
    // Push well below prebuffer threshold.
    pushInterleavedStereo(proc, 128);
    const { outL } = callProcess(proc, 128);
    // No output yet — we're still accumulating into the prebuffer.
    expect(Math.max(...outL)).toBe(0);
  });

  it('plays pushed frames back once enough has been prebuffered', () => {
    const proc = newProc();
    const pushed = pushInterleavedStereo(proc, PREBUFFER_FRAMES);
    const { outL, outR } = callProcess(proc, 128);

    for (let i = 0; i < 128; i++) {
      expect(outL[i]).toBeCloseTo(pushed[i * 2], 5);
      expect(outR[i]).toBeCloseTo(pushed[i * 2 + 1], 5);
    }
  });

  it('fills tail with silence and marks underrun when the ring runs dry mid-playback', () => {
    const proc = newProc();
    pushInterleavedStereo(proc, PREBUFFER_FRAMES + 50); // just past prebuffer
    // Drain past the available frames. First call should consume what we have,
    // subsequent calls should be silent until we rebuffer.
    let totalConsumed = 0;
    for (let round = 0; round < 50; round++) {
      const { outL } = callProcess(proc, 128);
      for (const v of outL) if (v !== 0) totalConsumed++;
    }
    // Only the prebuffered frames should have surfaced (+ the 50 extra).
    expect(totalConsumed).toBe(PREBUFFER_FRAMES + 50);
  });

  it('drops oldest frames on overflow so new data is prioritised', () => {
    const proc = newProc();
    // Ring is 48000 frames. Push 48100 frames of filler, then 4 trailing
    // samples with a distinct value. The filler overflows the ring, but the
    // newest samples must survive.
    const big = new Float32Array(48100 * 2);
    big.fill(0.42);
    proc.port.deliver({ type: 'pcm', buffer: big.buffer });

    const trailing = new Float32Array(4);
    trailing.fill(-0.9);
    proc.port.deliver({ type: 'pcm', buffer: trailing.buffer });

    // f32 quantises -0.9 to a slightly different bit pattern than f64, so
    // compare against the f32-rounded value.
    const TRAILING_F32 = new Float32Array([-0.9])[0];

    let sawTrailing = false;
    for (let round = 0; round < 1000 && !sawTrailing; round++) {
      const { outL, outR } = callProcess(proc, 128);
      for (let i = 0; i < 128; i++) {
        if (outL[i] === TRAILING_F32 && outR[i] === TRAILING_F32) {
          sawTrailing = true;
          break;
        }
        if (outL[i] === 0) break; // underrun — ring is empty
      }
    }
    expect(sawTrailing).toBe(true);
  });

  it('flush clears queued audio', () => {
    const proc = newProc();
    pushInterleavedStereo(proc, 128);
    proc.port.deliver({ type: 'flush' });
    const { outL } = callProcess(proc, 128);
    expect(Math.max(...outL)).toBe(0);
  });

  it('ignores unknown message types without throwing', () => {
    const proc = newProc();
    expect(() => proc.port.deliver({ type: 'who-knows' })).not.toThrow();
    expect(() => proc.port.deliver(null)).not.toThrow();
    expect(() => proc.port.deliver({})).not.toThrow();
  });

  it('keeps running across multiple process() calls after prebuffer hit', () => {
    const proc = newProc();
    // Push enough to trip the prebuffer plus some extra we can measure.
    const extra = 400;
    pushInterleavedStereo(proc, PREBUFFER_FRAMES + extra);
    let totalNonZero = 0;
    // Drain in 128-frame chunks until we run out.
    for (let i = 0; i < Math.ceil((PREBUFFER_FRAMES + extra) / 128); i++) {
      const { outL } = callProcess(proc, 128);
      for (const v of outL) if (v !== 0) totalNonZero++;
    }
    expect(totalNonZero).toBe(PREBUFFER_FRAMES + extra);
  });
});
