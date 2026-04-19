import { app, BrowserWindow, globalShortcut, session } from 'electron';
import { createWriteStream, type WriteStream } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc-handlers';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let cleanup: (() => void) | null = null;
let logStream: WriteStream | null = null;

function installFileLogger(): string {
  const logPath = join(app.getPath('userData'), 'radioo-debug.log');
  logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n===== radioo started ${new Date().toISOString()} =====\n`);

  const stamp = (tag: string, args: unknown[]) => {
    const text = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    logStream?.write(`[${new Date().toISOString()}] [${tag}] ${text}\n`);
  };

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      stamp(`main:${level}`, args);
    };
  }

  return logPath;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 740,
    minWidth: 700,
    minHeight: 520,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Radioo',
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow!.show());

  mainWindow.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    const levels = ['verbose', 'info', 'warn', 'error'];
    const tag = `renderer:${levels[level] ?? level}`;
    logStream?.write(
      `[${new Date().toISOString()}] [${tag}] ${message} (${sourceId}:${line})\n`,
    );
  });

  // Permissions for microphone access. System audio now goes through the
  // proc-audio-capture sidecar, not getDisplayMedia, so we no longer need
  // display-capture here.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture'].includes(permission);
    callback(allowed);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  cleanup = setupIpcHandlers(mainWindow);

  // Global shortcuts (work even when app is not focused)
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-sys-mute');
  });
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    mainWindow?.webContents.send('shortcut', 'momentary-duck');
  });
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-screen-reader');
  });
  globalShortcut.register('CommandOrControl+I', () => {
    mainWindow?.webContents.send('shortcut', 'music-volume-up');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('shortcut', 'music-volume-down');
  });
}

app.whenReady().then(() => {
  const logPath = installFileLogger();
  console.log('[radioo] debug log:', logPath);
  createWindow();
});

app.on('will-quit', () => {
  cleanup?.();
  cleanup = null;
  globalShortcut.unregisterAll();
  logStream?.end();
  logStream = null;
});

app.on('window-all-closed', () => {
  app.quit();
});

// Handle SIGINT/SIGTERM for dev-mode Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    cleanup?.();
    cleanup = null;
    app.quit();
  });
}
