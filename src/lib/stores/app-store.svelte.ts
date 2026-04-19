import type { MicEffects, ServerProfile, StreamFormat } from '../types';

export type SyscapMode = 'all' | 'include' | 'exclude';

class AppStore {
  // Devices
  micDeviceId = $state('');
  availableDevices = $state<MediaDeviceInfo[]>([]);

  // Per-process system audio capture
  syscapEnabled = $state(false);
  // Default to 'all' (broad capture) so the common broadcaster workflow works
  // with one click. Switch to 'include'/'exclude' only when the user wants to
  // filter specific processes.
  syscapMode = $state<SyscapMode>('all');
  syscapPids = $state<number[]>([]);
  // Cached friendly names for persisted PIDs (used by the UI between launches
  // before a fresh syscap:list returns).
  syscapPidNames = $state<Record<number, string>>({});
  syscapSupported = $state(true);

  // Gains (0–2 range, 1 = unity)
  micGain = $state(1.0);
  sysGain = $state(1.0);
  masterGain = $state(1.0);
  micMuted = $state(false);

  // Mic effects
  effects = $state<MicEffects>({
    boost: false,
    noiseGate: false,
    compressor: true,
    presence: true,
    megaphone: false,
    reverb: false,
  });

  // Impulse response
  irFilePath = $state('');
  irFileName = $state('');

  // Ducking (applies to music player)
  duckingEnabled = $state(false);
  duckAmount = $state(0.5);

  // Music player
  musicFilePath = $state('');
  musicFileName = $state('');
  musicVolume = $state(100); // 0–100 integer
  musicPlaying = $state(false);
  muteSysWhileMusicPlaying = $state(false);

  // Server profiles
  serverProfiles = $state<ServerProfile[]>([]);
  activeProfileId = $state('');

  // Stream config (active values)
  streamUrl = $state('');
  streamUsername = $state('source');
  streamPassword = $state('');
  streamFormat = $state<StreamFormat>('mp3');
  streamBitrate = $state(192);
  streamName = $state('Radioo Stream');

  // HLS config
  hlsEnabled = $state(false);
  hlsPath = $state('');

  // Optional override for listener-count polling. When the broadcasted mount
  // is relayed (e.g., we SOURCE to /live.mp3 but audience listens on
  // /stream.mp3 via liquidsoap), set this to the public mount URL.
  listenerCountUrl = $state('');

  // UI
  language = $state<'en' | 'es' | 'fr' | 'it' | 'pt' | 'de' | 'ja'>('en');

  // Status
  streaming = $state(false);
  recording = $state(false);
  connected = $state(false);
  reconnecting = $state(false);
  duration = $state(0);
  listeners = $state(0);
  listenersError = $state<string | null>(null);
  error = $state<string | null>(null);
  hlsActive = $state(false);

  // Meters (updated by animation frame)
  micLevel = $state(0);
  masterLevelL = $state(0);
  masterLevelR = $state(0);

  // --- Server profile management ---

  saveProfile(name: string): void {
    const existing = this.serverProfiles.find((p) => p.id === this.activeProfileId);
    if (existing) {
      existing.name = name;
      existing.url = this.streamUrl;
      existing.username = this.streamUsername;
      existing.password = this.streamPassword;
      existing.streamName = this.streamName;
    } else {
      const id = crypto.randomUUID();
      this.serverProfiles.push({
        id,
        name,
        url: this.streamUrl,
        username: this.streamUsername,
        password: this.streamPassword,
        streamName: this.streamName,
      });
      this.activeProfileId = id;
    }
  }

  loadProfile(id: string): void {
    const p = this.serverProfiles.find((p) => p.id === id);
    if (!p) return;
    this.activeProfileId = id;
    this.streamUrl = p.url;
    this.streamUsername = p.username;
    this.streamPassword = p.password;
    this.streamName = p.streamName;
  }

  deleteProfile(id: string): void {
    this.serverProfiles = this.serverProfiles.filter((p) => p.id !== id);
    if (this.activeProfileId === id) {
      this.activeProfileId = '';
    }
  }

  // Serialise settings for persistence
  toSettings(): Record<string, unknown> {
    return {
      serverProfiles: this.serverProfiles.map((p) => ({ ...p })),
      activeProfileId: this.activeProfileId,
      streamUrl: this.streamUrl,
      streamUsername: this.streamUsername,
      streamPassword: this.streamPassword,
      streamFormat: this.streamFormat,
      streamBitrate: this.streamBitrate,
      streamName: this.streamName,
      micDeviceId: this.micDeviceId,
      syscapEnabled: this.syscapEnabled,
      syscapMode: this.syscapMode,
      syscapPids: [...this.syscapPids],
      syscapPidNames: { ...this.syscapPidNames },
      effects: { ...this.effects },
      irFilePath: this.irFilePath,
      irFileName: this.irFileName,
      duckingEnabled: this.duckingEnabled,
      duckAmount: this.duckAmount,
      micGain: this.micGain,
      sysGain: this.sysGain,
      masterGain: this.masterGain,
      hlsEnabled: this.hlsEnabled,
      hlsPath: this.hlsPath,
      listenerCountUrl: this.listenerCountUrl,
      musicFilePath: this.musicFilePath,
      musicFileName: this.musicFileName,
      musicVolume: this.musicVolume,
      micMuted: this.micMuted,
      language: this.language,
      muteSysWhileMusicPlaying: this.muteSysWhileMusicPlaying,
    };
  }

  loadSettings(s: Record<string, unknown>): void {
    if (!s) return;
    if (Array.isArray(s.serverProfiles)) this.serverProfiles = s.serverProfiles as ServerProfile[];
    if (typeof s.activeProfileId === 'string') this.activeProfileId = s.activeProfileId;
    if (typeof s.streamUrl === 'string') this.streamUrl = s.streamUrl;
    if (typeof s.streamUsername === 'string') this.streamUsername = s.streamUsername;
    if (typeof s.streamPassword === 'string') this.streamPassword = s.streamPassword;
    if (typeof s.streamFormat === 'string') this.streamFormat = s.streamFormat as StreamFormat;
    if (typeof s.streamBitrate === 'number') this.streamBitrate = s.streamBitrate;
    if (typeof s.streamName === 'string') this.streamName = s.streamName;
    if (typeof s.micDeviceId === 'string') this.micDeviceId = s.micDeviceId;
    // Migrate old sysAudioEnabled flag onto the new syscap* fields.
    if (typeof s.syscapEnabled === 'boolean') this.syscapEnabled = s.syscapEnabled;
    else if (typeof s.sysAudioEnabled === 'boolean') this.syscapEnabled = s.sysAudioEnabled;
    if (s.syscapMode === 'all' || s.syscapMode === 'include' || s.syscapMode === 'exclude') this.syscapMode = s.syscapMode;
    if (Array.isArray(s.syscapPids)) this.syscapPids = (s.syscapPids as unknown[]).filter((x): x is number => typeof x === 'number');
    if (s.syscapPidNames && typeof s.syscapPidNames === 'object') {
      const out: Record<number, string> = {};
      for (const [k, v] of Object.entries(s.syscapPidNames as Record<string, unknown>)) {
        const n = Number(k);
        if (Number.isFinite(n) && typeof v === 'string') out[n] = v;
      }
      this.syscapPidNames = out;
    }
    if (s.effects && typeof s.effects === 'object') Object.assign(this.effects, s.effects);
    if (typeof s.irFilePath === 'string') this.irFilePath = s.irFilePath;
    if (typeof s.irFileName === 'string') this.irFileName = s.irFileName;
    if (typeof s.duckingEnabled === 'boolean') this.duckingEnabled = s.duckingEnabled;
    if (typeof s.duckAmount === 'number') this.duckAmount = s.duckAmount;
    if (typeof s.micGain === 'number') this.micGain = s.micGain;
    if (typeof s.sysGain === 'number') this.sysGain = s.sysGain;
    if (typeof s.masterGain === 'number') this.masterGain = s.masterGain;
    if (typeof s.hlsEnabled === 'boolean') this.hlsEnabled = s.hlsEnabled;
    if (typeof s.hlsPath === 'string') this.hlsPath = s.hlsPath;
    if (typeof s.listenerCountUrl === 'string') this.listenerCountUrl = s.listenerCountUrl;
    if (typeof s.musicFilePath === 'string') this.musicFilePath = s.musicFilePath;
    if (typeof s.musicFileName === 'string') this.musicFileName = s.musicFileName;
    if (typeof s.musicVolume === 'number') this.musicVolume = s.musicVolume;
    if (typeof s.micMuted === 'boolean') this.micMuted = s.micMuted;
    if (typeof s.language === 'string' && ['en','es','fr','it','pt','de','ja'].includes(s.language)) {
      this.language = s.language as typeof this.language;
    }
    if (typeof s.muteSysWhileMusicPlaying === 'boolean') this.muteSysWhileMusicPlaying = s.muteSysWhileMusicPlaying;
  }

  get durationFormatted(): string {
    const h = Math.floor(this.duration / 3600);
    const m = Math.floor((this.duration % 3600) / 60);
    const s = this.duration % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
}

export const store = new AppStore();
