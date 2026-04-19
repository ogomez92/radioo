import { store } from './app-store.svelte';

function resetStore(): void {
  // Re-seed the singleton store back to construction defaults.
  store.serverProfiles = [];
  store.activeProfileId = '';
  store.streamUrl = '';
  store.streamUsername = 'source';
  store.streamPassword = '';
  store.streamFormat = 'mp3';
  store.streamBitrate = 192;
  store.streamName = 'Radioo Stream';
  store.micDeviceId = '';
  store.syscapEnabled = false;
  store.syscapMode = 'all';
  store.syscapPids = [];
  store.syscapPidNames = {};
  store.syscapSupported = true;
  store.effects = {
    boost: false,
    noiseGate: false,
    compressor: true,
    presence: true,
    megaphone: false,
    reverb: false,
  };
  store.irFilePath = '';
  store.irFileName = '';
  store.duckingEnabled = false;
  store.duckAmount = 0.5;
  store.micGain = 1.0;
  store.sysGain = 1.0;
  store.masterGain = 1.0;
  store.hlsEnabled = false;
  store.hlsPath = '';
  store.musicFilePath = '';
  store.musicFileName = '';
  store.musicVolume = 100;
  store.micMuted = false;
  store.language = 'en';
  store.muteSysWhileMusicPlaying = false;
  store.duration = 0;
}

describe('AppStore.toSettings / loadSettings', () => {
  beforeEach(resetStore);

  it('persists and restores a full configuration round-trip', () => {
    store.streamUrl = 'http://icecast.example.com:8000/live';
    store.streamPassword = 'hunter2';
    store.syscapEnabled = true;
    store.syscapMode = 'include';
    store.syscapPids = [42, 123];
    store.syscapPidNames = { 42: 'Spotify.exe', 123: 'firefox.exe' };
    store.effects.reverb = true;
    store.duckingEnabled = true;
    store.duckAmount = 0.7;
    store.language = 'es';

    const snapshot = store.toSettings();
    resetStore();
    store.loadSettings(snapshot);

    expect(store.streamUrl).toBe('http://icecast.example.com:8000/live');
    expect(store.streamPassword).toBe('hunter2');
    expect(store.syscapEnabled).toBe(true);
    expect(store.syscapMode).toBe('include');
    expect(store.syscapPids).toEqual([42, 123]);
    expect(store.syscapPidNames).toEqual({ 42: 'Spotify.exe', 123: 'firefox.exe' });
    expect(store.effects.reverb).toBe(true);
    expect(store.duckingEnabled).toBe(true);
    expect(store.duckAmount).toBe(0.7);
    expect(store.language).toBe('es');
  });

  it('migrates legacy sysAudioEnabled flag to syscapEnabled', () => {
    store.loadSettings({ sysAudioEnabled: true });
    expect(store.syscapEnabled).toBe(true);
  });

  it('prefers new syscapEnabled over legacy sysAudioEnabled when both are present', () => {
    store.loadSettings({ sysAudioEnabled: true, syscapEnabled: false });
    expect(store.syscapEnabled).toBe(false);
  });

  it('rejects invalid types silently', () => {
    store.streamUrl = 'preserved';
    store.loadSettings({ streamUrl: 42, syscapMode: 'bogus', syscapPids: 'oops', language: 'zz' });
    expect(store.streamUrl).toBe('preserved');
    expect(store.syscapMode).toBe('all');
    expect(store.syscapPids).toEqual([]);
    expect(store.language).toBe('en');
  });

  it('accepts all three syscap modes via loadSettings', () => {
    store.loadSettings({ syscapMode: 'all' });
    expect(store.syscapMode).toBe('all');
    store.loadSettings({ syscapMode: 'include' });
    expect(store.syscapMode).toBe('include');
    store.loadSettings({ syscapMode: 'exclude' });
    expect(store.syscapMode).toBe('exclude');
  });

  it('filters non-number entries from syscapPids and non-string entries from pidNames', () => {
    store.loadSettings({
      syscapPids: [1, '2', null, 3],
      syscapPidNames: { 1: 'a.exe', 2: 42, bad: 'x', 3: 'c.exe' },
    });
    expect(store.syscapPids).toEqual([1, 3]);
    expect(store.syscapPidNames).toEqual({ 1: 'a.exe', 3: 'c.exe' });
  });

  it('does nothing when called with null or undefined', () => {
    store.streamUrl = 'before';
    // @ts-expect-error - exercising runtime guard
    store.loadSettings(null);
    // @ts-expect-error - exercising runtime guard
    store.loadSettings(undefined);
    expect(store.streamUrl).toBe('before');
  });
});

describe('AppStore profile management', () => {
  beforeEach(resetStore);

  it('creates a new profile and makes it active', () => {
    store.streamUrl = 'http://a/b';
    store.streamUsername = 'u';
    store.streamPassword = 'p';
    store.streamName = 'Show';
    store.saveProfile('Primary');
    expect(store.serverProfiles).toHaveLength(1);
    expect(store.serverProfiles[0]).toMatchObject({
      name: 'Primary',
      url: 'http://a/b',
      username: 'u',
      password: 'p',
      streamName: 'Show',
    });
    expect(store.activeProfileId).toBe(store.serverProfiles[0].id);
  });

  it('updates the active profile when saveProfile is called again', () => {
    store.streamUrl = 'http://a/b';
    store.saveProfile('Primary');
    const id = store.activeProfileId;

    store.streamUrl = 'http://c/d';
    store.saveProfile('Primary (v2)');

    expect(store.serverProfiles).toHaveLength(1);
    expect(store.serverProfiles[0].url).toBe('http://c/d');
    expect(store.serverProfiles[0].name).toBe('Primary (v2)');
    expect(store.activeProfileId).toBe(id);
  });

  it('loadProfile pushes the profile values onto the live stream fields', () => {
    store.streamUrl = 'http://a/b';
    store.saveProfile('A');
    const firstId = store.activeProfileId;

    // Simulate a different profile being stored too.
    store.activeProfileId = '';
    store.streamUrl = 'http://c/d';
    store.saveProfile('B');

    // Now switch back to A.
    store.loadProfile(firstId);
    expect(store.streamUrl).toBe('http://a/b');
    expect(store.activeProfileId).toBe(firstId);
  });

  it('deleteProfile removes it and clears activeProfileId if it was active', () => {
    store.streamUrl = 'x';
    store.saveProfile('Only');
    const id = store.activeProfileId;

    store.deleteProfile(id);
    expect(store.serverProfiles).toHaveLength(0);
    expect(store.activeProfileId).toBe('');
  });
});

describe('AppStore syscap on/off preserves filter config', () => {
  beforeEach(resetStore);

  // The checkbox / Ctrl+Shift+M shortcut / auto-mute-while-music-plays all
  // toggle syscapEnabled. Flipping it must NOT wipe the user's chosen
  // include/exclude list — they want to come back to the same selection.
  it('toggling syscapEnabled preserves syscapMode and syscapPids', () => {
    store.syscapEnabled = true;
    store.syscapMode = 'exclude';
    store.syscapPids = [4567];

    store.syscapEnabled = false;
    expect(store.syscapMode).toBe('exclude');
    expect(store.syscapPids).toEqual([4567]);

    store.syscapEnabled = true;
    expect(store.syscapMode).toBe('exclude');
    expect(store.syscapPids).toEqual([4567]);
  });

  it('muteSysWhileMusicPlaying persists independent of syscap state', () => {
    store.syscapEnabled = true;
    store.syscapPids = [42];
    store.muteSysWhileMusicPlaying = true;
    // Simulated music-play transition disables capture.
    store.syscapEnabled = false;
    expect(store.muteSysWhileMusicPlaying).toBe(true);
    expect(store.syscapPids).toEqual([42]);
  });
});

describe('AppStore.durationFormatted', () => {
  beforeEach(resetStore);

  it('formats sub-hour durations as M:SS', () => {
    store.duration = 0;
    expect(store.durationFormatted).toBe('00:00');
    store.duration = 65;
    expect(store.durationFormatted).toBe('01:05');
    store.duration = 59 * 60 + 59;
    expect(store.durationFormatted).toBe('59:59');
  });

  it('formats hour-plus durations as H:MM:SS', () => {
    store.duration = 3600;
    expect(store.durationFormatted).toBe('1:00:00');
    store.duration = 3661;
    expect(store.durationFormatted).toBe('1:01:01');
  });
});
