import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  startEncoder: (config: unknown) => ipcRenderer.invoke('encoder:start', config),
  stopEncoder: () => ipcRenderer.invoke('encoder:stop'),
  sendAudioData: (buffer: ArrayBuffer) => ipcRenderer.send('audio:data', buffer),

  connectIcecast: (config: unknown) => ipcRenderer.invoke('icecast:connect', config),
  disconnectIcecast: () => ipcRenderer.invoke('icecast:disconnect'),

  startRecording: (config: unknown) => ipcRenderer.invoke('recording:start', config),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  startHls: (config: unknown) => ipcRenderer.invoke('hls:start', config),
  stopHls: () => ipcRenderer.invoke('hls:stop'),

  getListenerCount: (url: string) => ipcRenderer.invoke('listeners:get', url),

  onStatus: (callback: (status: Record<string, unknown>) => void) => {
    const handler = (_: unknown, status: Record<string, unknown>) => callback(status);
    ipcRenderer.on('status:update', handler);
    return () => { ipcRenderer.removeListener('status:update', handler); };
  },

  showSaveDialog: (options: unknown) => ipcRenderer.invoke('dialog:save', options),
  showOpenDialog: (options: unknown) => ipcRenderer.invoke('dialog:open', options),
  readBinaryFile: (filePath: string) => ipcRenderer.invoke('file:read-binary', filePath),

  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  saveSettingsSync: (settings: unknown) => ipcRenderer.sendSync('settings:save-sync', settings),

  onShortcut: (callback: (action: string) => void) => {
    const handler = (_: unknown, action: string) => callback(action);
    ipcRenderer.on('shortcut', handler);
    return () => { ipcRenderer.removeListener('shortcut', handler); };
  },

  // Per-process audio capture
  syscapSupported: () => ipcRenderer.invoke('syscap:supported'),
  syscapList: () => ipcRenderer.invoke('syscap:list'),
  syscapSetTargets: (mode: 'all' | 'include' | 'exclude', pids: number[]) =>
    ipcRenderer.invoke('syscap:set-targets', { mode, pids }),
  syscapStop: () => ipcRenderer.invoke('syscap:stop'),
  syscapScreenReaderPid: () => ipcRenderer.invoke('syscap:screen-reader-pid'),
  onSyscapPcm: (callback: (payload: { pid: number; buffer: ArrayBuffer }) => void) => {
    const handler = (_: unknown, payload: { pid: number; buffer: ArrayBuffer }) => callback(payload);
    ipcRenderer.on('syscap:pcm', handler);
    return () => { ipcRenderer.removeListener('syscap:pcm', handler); };
  },
  onSyscapEnded: (callback: (payload: { pid: number; code: number | null; signal: string | null }) => void) => {
    const handler = (_: unknown, payload: { pid: number; code: number | null; signal: string | null }) => callback(payload);
    ipcRenderer.on('syscap:ended', handler);
    return () => { ipcRenderer.removeListener('syscap:ended', handler); };
  },
});
