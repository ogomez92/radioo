import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type CaptureMode = 'all' | 'include' | 'exclude';

export interface CaptureSession {
  pid: number;
  process_name: string;
  display_name: string;
  state: number; // 0 inactive, 1 active, 2 expired
}

const PLATFORM_OK = process.platform === 'win32' || process.platform === 'darwin';
const EXE_NAME = process.platform === 'win32' ? 'proc-audio-capture.exe' : 'proc-audio-capture';

function resolveBinary(): string | null {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'proc-audio-capture', EXE_NAME);
    return existsSync(p) ? p : null;
  }
  // Dev: built artifact next to the Rust crate.
  const p = path.resolve(process.cwd(), 'native', 'proc-audio-capture', 'target', 'release', EXE_NAME);
  return existsSync(p) ? p : null;
}

interface RunningChild {
  // Key under which we track this child. For include/exclude it's the target
  // PID; for 'all' we use the sentinel ALL_PID_KEY since every chunk is
  // forwarded under the same renderer-side pseudo-pid.
  key: number;
  child: ChildProcess;
  stderrBuf: string;
  mode: CaptureMode;
  // Leftover bytes from the previous stdout read that didn't complete a full
  // stereo f32 frame. Node's pipe reads don't respect frame boundaries.
  stdoutRemainder: Buffer;
}

// Stereo f32 = 2 channels * 4 bytes. Everything we forward to the renderer
// worklet must be a multiple of this, or `new Float32Array(buffer)` throws.
const FRAME_BYTES = 8;

// Renderer-visible "pid" used for the single sidecar in 'all' mode. Zero is
// never a valid Windows PID, so it can't collide with a real process.
export const ALL_PID_KEY = 0;

export class ProcCaptureManager {
  private mainWindow: BrowserWindow;
  private children = new Map<number, RunningChild>();
  private mode: CaptureMode = 'include';
  private binaryMissingReported = false;
  // Lower-case exe name of the Electron binary hosting the renderer. Used
  // to filter ourselves out of listSessions() so the user never sees (and
  // can never accidentally capture) the app's own audio.
  private selfExeName: string;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.selfExeName = path.basename(process.execPath).toLowerCase();
  }

  get isSupported(): boolean {
    return PLATFORM_OK && resolveBinary() !== null;
  }

  get activePids(): number[] {
    return [...this.children.keys()];
  }

  async listSessions(): Promise<CaptureSession[]> {
    const bin = resolveBinary();
    if (!bin) {
      this.reportBinaryMissing();
      return [];
    }
    return new Promise((resolve) => {
      execFile(bin, ['list'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) {
          this.sendStatus({ error: `proc-audio-capture list failed: ${err.message}` });
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { sessions: CaptureSession[] };
          const filtered = (parsed.sessions ?? []).filter(
            (s) => s.process_name.toLowerCase() !== this.selfExeName,
          );
          resolve(filtered);
        } catch {
          resolve([]);
        }
      });
    });
  }

  /** Reconciles running children against the desired target set. */
  async setTargets(mode: CaptureMode, pids: number[]): Promise<void> {
    if (!PLATFORM_OK) return;

    const bin = resolveBinary();
    if (!bin) {
      this.reportBinaryMissing();
      return;
    }

    const modeChanged = mode !== this.mode;
    this.mode = mode;

    if (mode === 'all') {
      // Single sidecar. We pass the renderer's OS PID so WASAPI's
      // process-loopback exclude-tree mode skips our own audio — the
      // broadcaster's monitor beeps stay local and don't leak into the
      // stream. If we can't resolve the renderer PID, fall back to the
      // sentinel-based system-wide loopback (which captures everything,
      // beeps included).
      const existing = this.children.get(ALL_PID_KEY);
      if (modeChanged || !existing) {
        this.stopAll();
        this.spawnChild(bin, ALL_PID_KEY, 'all');
      }
      return;
    }

    if (mode === 'exclude') {
      // WASAPI only supports ONE target PID per client. We run a single
      // sidecar with the first requested PID; additional PIDs are ignored.
      const [first] = pids;
      const currentPid = this.activePids[0];
      if (modeChanged || currentPid !== first) {
        this.stopAll();
        if (first !== undefined) this.spawnChild(bin, first, 'exclude');
      }
      return;
    }

    // Include mode: one sidecar per PID.
    if (modeChanged) this.stopAll();

    const desired = new Set(pids);
    for (const pid of desired) {
      if (!this.children.has(pid)) this.spawnChild(bin, pid, 'include');
    }
    for (const pid of this.activePids) {
      if (!desired.has(pid)) this.stopChild(pid);
    }
  }

  stopAll(): void {
    for (const pid of this.activePids) this.stopChild(pid);
  }

  private spawnChild(bin: string, key: number, mode: CaptureMode): void {
    const baseArgs: string[] = [
      '--sample-rate', '48000',
      '--channels', '2',
      // 50 ms chunks — big enough to amortise IPC + postMessage overhead
      // into the audio worklet, small enough that monitor latency stays low.
      '--chunk-frames', '2400',
    ];
    let modeArgs: string[];
    if (mode === 'all') {
      // Prefer process-loopback exclude-tree with the renderer PID (the
      // process actually rendering our beeps). An earlier version of this
      // code tried the main PID and got silence; main doesn't drive audio,
      // so WASAPI's exclude-target-process-tree couldn't find anything to
      // subtract. If getOSProcessId fails for any reason, fall back to
      // --capture-all (system-wide loopback; beeps will leak).
      const rendererPid = this.resolveRendererPid();
      modeArgs = rendererPid !== null
        ? ['--exclude-pid', String(rendererPid)]
        : ['--capture-all'];
    } else {
      modeArgs = [mode === 'include' ? '--include-pid' : '--exclude-pid', String(key)];
    }
    const args = [...modeArgs, ...baseArgs];
    console.log('[proc-capture] spawn', bin, args.join(' '));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const entry: RunningChild = { key, child, stderrBuf: '', mode, stdoutRemainder: Buffer.alloc(0) };
    this.children.set(key, entry);

    let firstChunkLogged = false;
    let bytesTotal = 0;
    let lastBytesLog = Date.now();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.mainWindow.isDestroyed()) return;
      bytesTotal += chunk.length;

      // Re-align to stereo-f32 frame boundaries. Pipe reads can deliver any
      // byte count, but the renderer worklet requires a multiple of 8 —
      // otherwise `new Float32Array(buffer)` throws on odd byte counts and
      // channel alignment drifts on odd float counts.
      const combined = entry.stdoutRemainder.length === 0
        ? chunk
        : Buffer.concat([entry.stdoutRemainder, chunk]);
      const alignedLen = combined.length - (combined.length % FRAME_BYTES);
      if (alignedLen === 0) {
        entry.stdoutRemainder = combined;
        return;
      }
      const aligned = combined.subarray(0, alignedLen);
      entry.stdoutRemainder = alignedLen === combined.length
        ? Buffer.alloc(0)
        : Buffer.from(combined.subarray(alignedLen));

      if (!firstChunkLogged) {
        firstChunkLogged = true;
        // Peak of the first aligned chunk as an f32 sanity check — 0 means
        // the sidecar is delivering silence; >0 means there's signal.
        let peak = 0;
        const floats = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
        for (let i = 0; i < floats.length; i++) {
          const a = Math.abs(floats[i]);
          if (a > peak) peak = a;
        }
        console.log('[proc-capture] first pcm chunk key=%d bytes=%d peak=%f', key, aligned.length, peak);
      }
      const now = Date.now();
      if (now - lastBytesLog > 3000) {
        const kbps = ((bytesTotal * 8) / ((now - lastBytesLog) / 1000)) / 1024;
        console.log('[proc-capture] rx key=%d %d KB last 3s (%d kbps)', key, Math.round(bytesTotal / 1024), Math.round(kbps));
        bytesTotal = 0;
        lastBytesLog = now;
      }
      // Copy into a standalone ArrayBuffer so structured-clone across IPC
      // gets exactly the aligned bytes (and not a view into a larger pool).
      const ab = aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength);
      this.mainWindow.webContents.send('syscap:pcm', { pid: key, buffer: ab });
    });
    // When we kill the child, Node's pipe can still emit 'error' for in-flight
    // reads/writes (EPIPE, ECONNRESET). Swallow those — 'exit' handles cleanup.
    child.stdout.on('error', () => { /* child dying — handled by 'exit' */ });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      entry.stderrBuf += data;
      let nl: number;
      while ((nl = entry.stderrBuf.indexOf('\n')) !== -1) {
        const line = entry.stderrBuf.slice(0, nl).trim();
        entry.stderrBuf = entry.stderrBuf.slice(nl + 1);
        if (!line) continue;
        this.handleStatusLine(key, line);
      }
    });
    child.stderr.on('error', () => { /* see stdout comment */ });

    child.on('exit', (code, signal) => {
      console.log('[proc-capture] exit key=%d code=%s signal=%s', key, code, signal);
      this.children.delete(key);
      if (this.mainWindow.isDestroyed()) return;
      this.mainWindow.webContents.send('syscap:ended', { pid: key, code, signal });
    });

    child.on('error', (err) => {
      this.sendStatus({ error: `proc-audio-capture (${this.labelFor(key)}): ${err.message}` });
    });
  }

  private stopChild(key: number): void {
    const entry = this.children.get(key);
    if (!entry) return;
    this.children.delete(key);
    try {
      entry.child.stdout?.removeAllListeners();
      entry.child.stderr?.removeAllListeners();
      entry.child.kill();
    } catch { /* already dead */ }
  }

  private labelFor(key: number): string {
    return key === ALL_PID_KEY ? 'all-mode' : `pid ${key}`;
  }

  private handleStatusLine(key: number, line: string): void {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'ready') {
        console.log('[proc-capture] ready', JSON.stringify(obj));
        this.sendStatus({ syscapReady: { pid: key } });
      } else if (obj.type === 'error') {
        console.error('[proc-capture] error:', obj.message);
        this.sendStatus({ error: `proc-audio-capture (${this.labelFor(key)}): ${obj.message ?? 'unknown'}` });
      }
    } catch {
      // Non-JSON stderr line — ignore.
    }
  }

  private sendStatus(update: Record<string, unknown>): void {
    if (this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('status:update', update);
  }

  private resolveRendererPid(): number | null {
    try {
      const pid = this.mainWindow.webContents.getOSProcessId();
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private reportBinaryMissing(): void {
    if (this.binaryMissingReported) return;
    this.binaryMissingReported = true;
    const msg = PLATFORM_OK
      ? 'Per-process capture sidecar not found. Run `pnpm build:sidecar` or reinstall the app.'
      : 'Per-process capture is only supported on Windows and macOS.';
    this.sendStatus({ error: msg });
  }
}

/** Returns the first PID whose process name matches a known screen reader. */
export async function findScreenReaderPid(): Promise<number | null> {
  if (process.platform === 'win32') {
    return findPidWindows(/^(nvda|jfw|jaws|narrator|fsreader)(\d*)?\.exe$/i);
  }
  if (process.platform === 'darwin') {
    return findPidMac(/^VoiceOver$/i);
  }
  return null;
}

function findPidWindows(nameRegex: RegExp): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        for (const line of stdout.split(/\r?\n/)) {
          // Each line: "imagename","pid","session","sessname","mem"
          const fields = line.match(/"([^"]*)"/g);
          if (!fields || fields.length < 2) continue;
          const name = fields[0].slice(1, -1);
          const pid = parseInt(fields[1].slice(1, -1), 10);
          if (!Number.isFinite(pid)) continue;
          if (nameRegex.test(name)) { resolve(pid); return; }
        }
        resolve(null);
      },
    );
  });
}

function findPidMac(nameRegex: RegExp): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,comm='], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const pid = parseInt(line.slice(0, spaceIdx), 10);
        const fullPath = line.slice(spaceIdx + 1).trim();
        const name = fullPath.split('/').pop() ?? fullPath;
        if (!Number.isFinite(pid)) continue;
        if (nameRegex.test(name)) { resolve(pid); return; }
      }
      resolve(null);
    });
  });
}
