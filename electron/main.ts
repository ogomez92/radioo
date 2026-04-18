import { app, BrowserWindow, desktopCapturer, globalShortcut, session } from 'electron';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc-handlers';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let cleanup: (() => void) | null = null;

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

  // Auto-grant system audio loopback capture without picker
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      }
    });
  });

  // Permissions for microphone access
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'display-capture'].includes(permission);
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
  globalShortcut.register('CommandOrControl+I', () => {
    mainWindow?.webContents.send('shortcut', 'music-volume-up');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('shortcut', 'music-volume-down');
  });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  cleanup?.();
  cleanup = null;
  globalShortcut.unregisterAll();
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
