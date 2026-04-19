// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.mock hoists above imports, so mock instances have to live inside
// vi.hoisted() to be in scope when the mock factory runs.
const { spawnMock, execFileMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(true),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
    execFile: execFileMock,
  };
});

// Import under test AFTER mocks are declared.
import { ProcCaptureManager, findScreenReaderPid } from './proc-capture';

// --- Fake child process ---

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr: EventEmitter & { setEncoding: (enc: string) => void };
  kill: ReturnType<typeof vi.fn>;
  args: string[];
  bin: string;
}

function makeChild(bin: string, args: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn();
  child.bin = bin;
  child.args = args;
  return child;
}

function makeWindow(opts: { rendererPid?: number | Error } = {}) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const getOSProcessId = () => {
    if (opts.rendererPid instanceof Error) throw opts.rendererPid;
    return opts.rendererPid ?? 0;
  };
  return {
    sent,
    win: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
        getOSProcessId,
      },
    } as unknown as import('electron').BrowserWindow,
  };
}

// --- Tests ---

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);

  // Default spawn: return a fresh fake child that records its args.
  spawnMock.mockImplementation((bin: string, args: string[]) => makeChild(bin, args));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProcCaptureManager.setTargets — 'all' mode", () => {
  // With a resolvable renderer PID we use process-loopback exclude-tree so the
  // app's own beeps don't leak into the captured stream. Without one we fall
  // back to the sentinel --capture-all (system-wide loopback).

  it('spawns one sidecar excluding the renderer PID when getOSProcessId resolves', async () => {
    const { win } = makeWindow({ rendererPid: 4242 });
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('all', []);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--exclude-pid');
    expect(args).toContain('4242');
    expect(args).not.toContain('--capture-all');
    expect(args).not.toContain('--include-pid');
  });

  it('falls back to --capture-all when the renderer PID is unavailable', async () => {
    const { win } = makeWindow({ rendererPid: new Error('not yet loaded') });
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('all', []);

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--capture-all');
    expect(args).not.toContain('--exclude-pid');
  });

  it('tags outgoing PCM with the ALL_PID_KEY sentinel (0) so the renderer has a stable key', async () => {
    const { win, sent } = makeWindow({ rendererPid: 4242 });
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('all', []);
    const child = spawnMock.mock.results[0].value as FakeChild;
    child.stdout.emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    const pcm = sent.find((m) => m.channel === 'syscap:pcm');
    expect(pcm).toBeDefined();
    expect((pcm!.payload as { pid: number }).pid).toBe(0);
  });

  it('replaces the all-mode child when switching away and back', async () => {
    const { win } = makeWindow({ rendererPid: 4242 });
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('all', []);
    const first = spawnMock.mock.results[0].value as FakeChild;

    await mgr.setTargets('include', [42]);
    expect(first.kill).toHaveBeenCalled();

    spawnMock.mockClear();
    await mgr.setTargets('all', []);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0][1] as string[])).toContain('--exclude-pid');
  });

  it('is a no-op to call all mode twice in a row', async () => {
    const { win } = makeWindow({ rendererPid: 4242 });
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('all', []);
    spawnMock.mockClear();
    await mgr.setTargets('all', []);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('ProcCaptureManager.setTargets — include mode', () => {
  it('spawns one child per PID in include mode and tags stdout chunks correctly', async () => {
    const { win, sent } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [111, 222]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const spawnedArgs = spawnMock.mock.calls.map((call) => call[1] as string[]);
    expect(spawnedArgs[0]).toContain('--include-pid');
    expect(spawnedArgs[0]).toContain('111');
    expect(spawnedArgs[1]).toContain('--include-pid');
    expect(spawnedArgs[1]).toContain('222');

    // Pump a chunk through the first child's stdout; the manager should tag
    // it with the matching PID and forward on the syscap:pcm channel.
    // Use 8 bytes = one full stereo f32 frame so alignment lets it through.
    const firstChild = spawnMock.mock.results[0].value as FakeChild;
    const chunk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    firstChild.stdout.emit('data', chunk);

    const pcmMsgs = sent.filter((m) => m.channel === 'syscap:pcm');
    expect(pcmMsgs).toHaveLength(1);
    const payload = pcmMsgs[0].payload as { pid: number; buffer: ArrayBuffer };
    expect(payload.pid).toBe(111);
    expect(payload.buffer.byteLength).toBe(8);
  });

  it('reconciles: keeps existing children, spawns new, kills removed', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [111, 222]);
    const [childA, childB] = spawnMock.mock.results.map((r) => r.value as FakeChild);
    spawnMock.mockClear();

    await mgr.setTargets('include', [222, 333]);

    // 111 should be killed, 222 preserved, 333 newly spawned.
    expect(childA.kill).toHaveBeenCalledTimes(1);
    expect(childB.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0][1] as string[])).toContain('333');
  });

  it('is a no-op when called with the same PIDs again', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [111]);
    spawnMock.mockClear();
    await mgr.setTargets('include', [111]);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('ProcCaptureManager.setTargets — exclude mode', () => {
  it('spawns a single --exclude-pid child and drops additional PIDs', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('exclude', [555, 666]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--exclude-pid');
    expect(args).toContain('555');
    expect(args).not.toContain('666');
  });

  it('restarts with the new first PID when the selection changes', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('exclude', [555]);
    const firstChild = spawnMock.mock.results[0].value as FakeChild;
    spawnMock.mockClear();

    await mgr.setTargets('exclude', [999]);

    expect(firstChild.kill).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0][1] as string[])).toContain('999');
  });

  it('kills everything when switching from include to exclude mode', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [1, 2, 3]);
    const kills = spawnMock.mock.results.map((r) => (r.value as FakeChild).kill);
    spawnMock.mockClear();

    await mgr.setTargets('exclude', [99]);

    for (const k of kills) expect(k).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0][1] as string[])).toContain('--exclude-pid');
  });

  it('kills everything without spawning if the new exclude list is empty', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('exclude', [555]);
    const firstChild = spawnMock.mock.results[0].value as FakeChild;
    spawnMock.mockClear();

    await mgr.setTargets('exclude', []);

    expect(firstChild.kill).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('ProcCaptureManager — stdout frame alignment', () => {
  // Node pipe reads don't respect frame boundaries. The manager must hold
  // back leftover bytes until it has a multiple of 8 (stereo f32), otherwise
  // the renderer worklet throws RangeError constructing Float32Array on an
  // odd byte count and no sys audio reaches the stream.

  it('buffers a sub-frame read and flushes once a full frame is available', async () => {
    const { win, sent } = makeWindow();
    const mgr = new ProcCaptureManager(win);
    await mgr.setTargets('include', [42]);
    const child = spawnMock.mock.results[0].value as FakeChild;

    // 3 bytes — not even a single f32, let alone a stereo frame.
    child.stdout.emit('data', Buffer.from([1, 2, 3]));
    expect(sent.filter((m) => m.channel === 'syscap:pcm')).toHaveLength(0);

    // 5 more bytes brings us to 8 — exactly one stereo f32 frame.
    child.stdout.emit('data', Buffer.from([4, 5, 6, 7, 8]));
    const msgs = sent.filter((m) => m.channel === 'syscap:pcm');
    expect(msgs).toHaveLength(1);
    expect((msgs[0].payload as { buffer: ArrayBuffer }).buffer.byteLength).toBe(8);
  });

  it('holds back the trailing partial frame and prepends it to the next read', async () => {
    const { win, sent } = makeWindow();
    const mgr = new ProcCaptureManager(win);
    await mgr.setTargets('include', [42]);
    const child = spawnMock.mock.results[0].value as FakeChild;

    // 10 bytes = one full frame (8) + 2 leftover.
    child.stdout.emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    let msgs = sent.filter((m) => m.channel === 'syscap:pcm');
    expect(msgs).toHaveLength(1);
    expect((msgs[0].payload as { buffer: ArrayBuffer }).buffer.byteLength).toBe(8);

    // 6 more bytes + the 2 leftover = 8, another full frame.
    child.stdout.emit('data', Buffer.from([11, 12, 13, 14, 15, 16]));
    msgs = sent.filter((m) => m.channel === 'syscap:pcm');
    expect(msgs).toHaveLength(2);
    const second = new Uint8Array((msgs[1].payload as { buffer: ArrayBuffer }).buffer);
    // First two bytes of the second frame must be the leftover 9, 10.
    expect(Array.from(second)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
});

describe('ProcCaptureManager — lifecycle & reporting', () => {
  it('emits syscap:ended when a child exits on its own', async () => {
    const { win, sent } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [42]);
    const child = spawnMock.mock.results[0].value as FakeChild;

    child.emit('exit', 0, null);

    const ended = sent.find((m) => m.channel === 'syscap:ended');
    expect(ended).toBeDefined();
    expect((ended!.payload as { pid: number }).pid).toBe(42);
    expect(mgr.activePids).not.toContain(42);
  });

  it('parses JSON status lines from stderr and forwards errors as status:update', async () => {
    const { win, sent } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [42]);
    const child = spawnMock.mock.results[0].value as FakeChild;

    child.stderr.emit('data', '{"type":"error","message":"boom"}\n');

    const statusMsgs = sent.filter((m) => m.channel === 'status:update');
    expect(statusMsgs.length).toBeGreaterThan(0);
    const last = statusMsgs[statusMsgs.length - 1].payload as { error?: string };
    expect(last.error).toContain('boom');
    expect(last.error).toContain('42');
  });

  it('isSupported returns false when the binary is missing', () => {
    existsSyncMock.mockReturnValue(false);
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);
    expect(mgr.isSupported).toBe(false);
  });

  it('stopAll kills every running child', async () => {
    const { win } = makeWindow();
    const mgr = new ProcCaptureManager(win);

    await mgr.setTargets('include', [1, 2, 3]);
    const kills = spawnMock.mock.results.map((r) => (r.value as FakeChild).kill);

    mgr.stopAll();
    for (const k of kills) expect(k).toHaveBeenCalled();
    expect(mgr.activePids).toHaveLength(0);
  });
});

describe('findScreenReaderPid — Windows tasklist parsing', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  function mockTasklist(stdout: string) {
    (execFileMock as MockedFunction<typeof import('node:child_process').execFile>).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((_file: string, _args: any, _options: any, cb: any) => {
        cb(null, stdout, '');
        return {} as ReturnType<typeof import('node:child_process').execFile>;
      }) as never,
    );
  }

  it('finds NVDA by process name', async () => {
    mockTasklist(
      [
        '"svchost.exe","123","Services","0","5,120 K"',
        '"nvda.exe","4567","Console","1","45,120 K"',
        '"chrome.exe","8000","Console","1","120,000 K"',
      ].join('\r\n'),
    );
    await expect(findScreenReaderPid()).resolves.toBe(4567);
  });

  it('finds Narrator', async () => {
    mockTasklist('"Narrator.exe","2048","Console","1","10,240 K"');
    await expect(findScreenReaderPid()).resolves.toBe(2048);
  });

  it('returns null when no screen reader is running', async () => {
    mockTasklist('"explorer.exe","1234","Console","1","100,000 K"');
    await expect(findScreenReaderPid()).resolves.toBeNull();
  });

  it('returns null when tasklist errors out', async () => {
    (execFileMock as MockedFunction<typeof import('node:child_process').execFile>).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((_f: string, _a: any, _o: any, cb: any) => {
        cb(new Error('nope'), '', '');
        return {} as ReturnType<typeof import('node:child_process').execFile>;
      }) as never,
    );
    await expect(findScreenReaderPid()).resolves.toBeNull();
  });
});

describe('findScreenReaderPid — macOS ps parsing', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  it('finds VoiceOver via ps output', async () => {
    (execFileMock as MockedFunction<typeof import('node:child_process').execFile>).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((_f: string, _a: any, _o: any, cb: any) => {
        cb(null, '  314 /usr/bin/login\n 912 /System/Library/CoreServices/VoiceOver\n 77 /usr/bin/ps\n', '');
        return {} as ReturnType<typeof import('node:child_process').execFile>;
      }) as never,
    );
    await expect(findScreenReaderPid()).resolves.toBe(912);
  });
});
