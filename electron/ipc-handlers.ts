import { app, ipcMain, dialog, type BrowserWindow } from 'electron';
import { Encoder, HlsEncoder, type EncoderConfig } from './encoder';
import { IcecastClient, type IcecastConfig } from './icecast';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from server')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export function setupIpcHandlers(mainWindow: BrowserWindow): () => void {
  const encoder = new Encoder();
  const hlsEncoder = new HlsEncoder();
  const icecast = new IcecastClient();
  let recordingStream: fs.WriteStream | null = null;
  let startTime = 0;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let listenerTimer: ReturnType<typeof setInterval> | null = null;
  let currentIcecastUrl = '';

  function sendStatus(update: Record<string, unknown>): void {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status:update', update);
    }
  }

  // Encoder
  ipcMain.handle('encoder:start', (_ev, config: EncoderConfig) => {
    encoder.start(config);
    startTime = Date.now();
    durationTimer = setInterval(() => {
      sendStatus({ duration: Math.floor((Date.now() - startTime) / 1000) });
    }, 1000);
    return true;
  });

  ipcMain.handle('encoder:stop', () => {
    encoder.stop();
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    startTime = 0;
    sendStatus({ duration: 0 });
    return true;
  });

  ipcMain.on('audio:data', (_ev, buffer: ArrayBuffer) => {
    const pcm = Buffer.from(buffer);
    encoder.write(pcm);
    hlsEncoder.write(pcm);
  });

  encoder.on('data', (data: Buffer) => {
    icecast.send(data);
    recordingStream?.write(data);
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
  ipcMain.handle('icecast:connect', async (_ev, config: IcecastConfig) => {
    try {
      await icecast.connect(config);
      currentIcecastUrl = config.url;
      sendStatus({ connected: true, streaming: true, error: null });
      startListenerPolling(config.url);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendStatus({ connected: false, error: msg });
      return { success: false, error: msg };
    }
  });

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
    return pollListeners(serverUrl);
  });

  function startListenerPolling(serverUrl: string): void {
    stopListenerPolling();
    listenerTimer = setInterval(async () => {
      const count = await pollListeners(serverUrl);
      sendStatus({ listeners: count });
    }, 10000);
  }

  function stopListenerPolling(): void {
    if (listenerTimer) { clearInterval(listenerTimer); listenerTimer = null; }
  }

  async function pollListeners(serverUrl: string): Promise<number> {
    try {
      const parsed = new URL(serverUrl);
      const statusUrl = `${parsed.protocol}//${parsed.host}/status-json.xsl`;
      const mount = parsed.pathname;

      const data = await fetchJson(statusUrl) as Record<string, unknown>;
      const icestats = data?.icestats as Record<string, unknown> | undefined;
      if (!icestats) return -1;

      const rawSource = icestats.source;
      const sources = Array.isArray(rawSource) ? rawSource : rawSource ? [rawSource] : [];
      const source = sources.find((s: Record<string, unknown>) =>
        typeof s.listenurl === 'string' && s.listenurl.endsWith(mount)
      );
      return typeof source?.listeners === 'number' ? source.listeners : 0;
    } catch {
      return -1;
    }
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

  // Cleanup function for graceful shutdown
  return function cleanup(): void {
    icecast.disconnect();
    encoder.stop();
    hlsEncoder.stop();
    if (recordingStream) {
      recordingStream.end();
      recordingStream = null;
    }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    stopListenerPolling();
  };
}
