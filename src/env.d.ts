/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ElectronAPI {
  startEncoder(config: import('./lib/types').EncoderConfig): Promise<boolean>;
  stopEncoder(): Promise<boolean>;
  sendAudioData(buffer: ArrayBuffer): void;
  connectIcecast(config: import('./lib/types').IcecastConfig): Promise<{ success: boolean; error?: string }>;
  disconnectIcecast(): Promise<boolean>;
  startRecording(config: { path: string }): Promise<boolean>;
  stopRecording(): Promise<boolean>;
  startHls(config: { path: string; format: string; bitrate: number; sampleRate: number; channels: number }): Promise<boolean>;
  stopHls(): Promise<boolean>;
  getListenerCount(url: string): Promise<number>;
  onStatus(callback: (status: Record<string, unknown>) => void): () => void;
  showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue>;
  loadSettings(): Promise<Record<string, unknown> | null>;
  saveSettings(settings: Record<string, unknown>): Promise<boolean>;
  saveSettingsSync(settings: Record<string, unknown>): boolean;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  readBinaryFile(filePath: string): Promise<ArrayBuffer>;
  onShortcut(callback: (action: string) => void): () => void;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}

export {};
