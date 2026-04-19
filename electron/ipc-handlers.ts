import { app, ipcMain, dialog, type BrowserWindow } from 'electron';
import { Encoder, HlsEncoder, type EncoderConfig } from './encoder';
import { IcecastClient, type IcecastConfig } from './icecast';
import { ProcCaptureManager, findScreenReaderPid, type CaptureMode } from './proc-capture';
import { pollListeners, resolvePollUrl } from './listener-poll';
import * as fs from 'fs';
import * as path from 'path';

export function setupIpcHandlers(mainWindow: BrowserWindow): () => void {
  const encoder = new Encoder();
  const hlsEncoder = new HlsEncoder();
  const icecast = new IcecastClient();
  const procCapture = new ProcCaptureManager(mainWindow);
  let recordingStream: fs.WriteStream | null = null;
  let startTime = 0;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let listenerTimer: ReturnType<typeof setInterval> | null = null;
  let currentIcecastUrl = '';

  // Watchdog for renderer → main PCM flow. Gaps > 200 ms while the encoder is
  // running point at audio-thread overload, which manifests as stream crackle.
  let lastAudioDataAt = 0;
  let lastAudioPayload = 0;

  function sendStatus(update: Record<string, unknown>): void {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status:update', update);
    }
  }

  // Encoder
  ipcMain.handle('encoder:start', (_ev, config: EncoderConfig) => {
    console.log('[encoder] start', JSON.stringify(config));
    encoder.start(config);
    startTime = Date.now();
    lastAudioDataAt = 0;
    durationTimer = setInterval(() => {
      sendStatus({ duration: Math.floor((Date.now() - startTime) / 1000) });
    }, 1000);
    return true;
  });

  ipcMain.handle('encoder:stop', () => {
    console.log('[encoder] stop');
    encoder.stop();
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    startTime = 0;
    lastAudioDataAt = 0;
    sendStatus({ duration: 0 });
    return true;
  });

  // Periodic peak sampling of outgoing PCM, so we can see whether the
  // renderer is actually mixing any audio into the stream. Throttled to
  // once per second to avoid spam.
  let lastPeakLogAt = 0;
  ipcMain.on('audio:data', (_ev, buffer: ArrayBuffer) => {
    const now = Date.now();
    if (lastAudioDataAt !== 0 && now - lastAudioDataAt > 200) {
      console.warn(
        '[audio] renderer gap %d ms (prev payload %d bytes)',
        now - lastAudioDataAt,
        lastAudioPayload,
      );
    }
    lastAudioDataAt = now;
    lastAudioPayload = buffer.byteLength;

    if (now - lastPeakLogAt > 1000) {
      let peak = 0;
      const floats = new Float32Array(buffer);
      for (let i = 0; i < floats.length; i++) {
        const a = Math.abs(floats[i]);
        if (a > peak) peak = a;
      }
      console.log('[audio] out peak=%f (%d samples)', peak.toFixed(4), floats.length);
      lastPeakLogAt = now;
    }

    const pcm = Buffer.from(buffer);
    encoder.write(pcm);
    hlsEncoder.write(pcm);
  });

  encoder.on('data', (data: Buffer) => {
    icecast.send(data);
    recordingStream?.write(data);
  });

  encoder.on('log', (line: string) => {
    // ffmpeg warnings/errors — these usually indicate clipping, buffer
    // underrun, or encoding hiccups, all of which manifest as crackling.
    console.log('[ffmpeg]', line);
  });

  encoder.on('close', (code: number | null) => {
    console.log('[encoder] ffmpeg exited code=%s', code);
  });

  encoder.on('error', (err: NodeJS.ErrnoException) => {
    let detail: string;
    if (err.code === 'ENOENT') {
      detail = 'ffmpeg not found — install ffmpeg and make sure it is on your PATH';
    } else {
      detail = `Encoder error: ${err.message}`;
    }
    sendStatus({ error: detail });
  });

  // HLS
  ipcMain.handle('hls:start', (_ev, config: EncoderConfig & { hlsPath: string }) => {
    hlsEncoder.start(config);
    sendStatus({ hlsActive: true });
    return true;
  });

  ipcMain.handle('hls:stop', () => {
    hlsEncoder.stop();
    sendStatus({ hlsActive: false });
    return true;
  });

  // Icecast
  ipcMain.handle(
    'icecast:connect',
    async (_ev, config: IcecastConfig & { listenerCountUrl?: string }) => {
      try {
        await icecast.connect(config);
        currentIcecastUrl = config.url;
        sendStatus({ connected: true, streaming: true, error: null });
        startListenerPolling(resolvePollUrl(config.url, config.listenerCountUrl));
        return { success: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendStatus({ connected: false, error: msg });
        return { success: false, error: msg };
      }
    },
  );

  ipcMain.handle('icecast:disconnect', () => {
    icecast.disconnect();
    stopListenerPolling();
    sendStatus({ connected: false, streaming: false, listeners: 0 });
    return true;
  });

  icecast.on('connected', () => sendStatus({ connected: true, reconnecting: false, error: null }));
  icecast.on('disconnected', () => sendStatus({ connected: false }));
  icecast.on('reconnecting', () => sendStatus({ reconnecting: true }));
  icecast.on('error', (err: Error) => sendStatus({ error: err.message }));

  // Recording
  ipcMain.handle('recording:start', (_ev, config: { path: string }) => {
    try {
      recordingStream = fs.createWriteStream(config.path);
      sendStatus({ recording: true });
      return true;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      let detail: string;
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        detail = `Permission denied writing to "${config.path}"`;
      } else if (e.code === 'ENOENT') {
        detail = `Directory does not exist for "${config.path}"`;
      } else {
        detail = `Recording error: ${e.message || err}`;
      }
      sendStatus({ error: detail });
      return false;
    }
  });

  ipcMain.handle('recording:stop', () => {
    if (recordingStream) {
      recordingStream.end();
      recordingStream = null;
    }
    sendStatus({ recording: false });
    return true;
  });

  // Listener count
  ipcMain.handle('listeners:get', async (_ev, serverUrl: string) => {
    const { count } = await pollListeners(serverUrl);
    return count;
  });

  // Increments on every start/stop. An in-flight poll compares the generation
  // it captured at tick-start against the live value; if they differ, it
  // drops its status update. Otherwise a slow tick can overwrite the `0` sent
  // by disconnectIcecast and leave the UI showing stale listener counts.
  let pollGeneration = 0;

  function startListenerPolling(serverUrl: string): void {
    stopListenerPolling();
    pollGeneration += 1;
    const gen = pollGeneration;
    const tick = async () => {
      const result = await pollListeners(serverUrl);
      if (gen !== pollGeneration) return;
      if (result.error) {
        sendStatus({ listenersError: result.error, listeners: -1 });
      } else {
        sendStatus({ listeners: result.count, listenersError: null });
      }
    };
    tick();
    listenerTimer = setInterval(tick, 5000);
  }

  function stopListenerPolling(): void {
    pollGeneration += 1;
    if (listenerTimer) { clearInterval(listenerTimer); listenerTimer = null; }
  }

  // File dialogs
  ipcMain.handle('dialog:save', async (_ev, options: Electron.SaveDialogOptions) => {
    return dialog.showSaveDialog(mainWindow, options);
  });

  ipcMain.handle('dialog:open', async (_ev, options: Electron.OpenDialogOptions) => {
    return dialog.showOpenDialog(mainWindow, options);
  });

  // Read a file as ArrayBuffer (for loading IR files etc.)
  ipcMain.handle('file:read-binary', async (_ev, filePath: string) => {
    const data = fs.readFileSync(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });

  // Settings persistence
  const settingsPath = path.join(app.getPath('userData'), 'webice-settings.json');
  console.log('[webice] settings path:', settingsPath);

  ipcMain.handle('settings:load', () => {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      console.log('[webice] settings loaded');
      return data;
    } catch (err) {
      console.log('[webice] settings load failed:', (err as Error).message);
      return null;
    }
  });

  function writeSettings(settings: unknown): boolean {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('[webice] settings saved');
      return true;
    } catch (err) {
      console.error('[webice] settings save failed:', err);
      return false;
    }
  }

  ipcMain.handle('settings:save', (_ev, settings: unknown) => writeSettings(settings));
  ipcMain.on('settings:save-sync', (ev, settings: unknown) => {
    ev.returnValue = writeSettings(settings);
  });

  // Per-process capture
  ipcMain.handle('syscap:supported', () => procCapture.isSupported);
  ipcMain.handle('syscap:list', () => procCapture.listSessions());
  ipcMain.handle(
    'syscap:set-targets',
    (_ev, payload: { mode: CaptureMode; pids: number[] }) =>
      procCapture.setTargets(payload.mode, payload.pids ?? []),
  );
  ipcMain.handle('syscap:stop', () => { procCapture.stopAll(); });
  ipcMain.handle('syscap:screen-reader-pid', () => findScreenReaderPid());

  // Cleanup function for graceful shutdown
  return function cleanup(): void {
    icecast.disconnect();
    encoder.stop();
    hlsEncoder.stop();
    procCapture.stopAll();
    if (recordingStream) {
      recordingStream.end();
      recordingStream = null;
    }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    stopListenerPolling();
  };
}
