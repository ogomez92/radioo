<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { AudioEngine } from './lib/audio/engine';
  import { store } from './lib/stores/app-store.svelte';
  import type { MicEffects } from './lib/types';
  import DeviceSelector from './lib/components/DeviceSelector.svelte';
  import EffectsPanel from './lib/components/EffectsPanel.svelte';
  import MixerPanel from './lib/components/MixerPanel.svelte';
  import MusicPlayerPanel from './lib/components/MusicPlayerPanel.svelte';
  import ServerPanel from './lib/components/ServerPanel.svelte';
  import RecordingPanel from './lib/components/RecordingPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import './app.css';

  let engine: AudioEngine | null = null;
  let meterInterval: ReturnType<typeof setInterval>;
  let removeStatusListener: (() => void) | null = null;
  let removeShortcutListener: (() => void) | null = null;
  let momentaryDuckActive = false;
  let muteAnnouncement = $state('');

  type TabId = 'main' | 'server' | 'recording' | 'effects';
  let activeTab = $state<TabId>('main');

  const tabs: { id: TabId; label: string }[] = [
    { id: 'main', label: 'Main' },
    { id: 'server', label: 'Server' },
    { id: 'recording', label: 'Recording' },
    { id: 'effects', label: 'Effects' },
  ];

  function handleTabKeydown(e: KeyboardEvent) {
    const idx = tabs.findIndex((t) => t.id === activeTab);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    activeTab = tabs[next].id;
    document.getElementById(`tab-${tabs[next].id}`)?.focus();
  }

  onMount(async () => {
    engine = new AudioEngine();
    await engine.init((pcm: Float32Array) => {
      window.api?.sendAudioData(pcm.buffer as ArrayBuffer);
    });
    engine.setMusicEndedCallback(() => {
      store.musicPlaying = false;
      announce('Music finished');
    });

    meterInterval = setInterval(() => {
      if (!engine) return;
      store.micLevel = engine.getMicLevel();
      const [l, r] = engine.getMasterLevel();
      store.masterLevelL = l;
      store.masterLevelR = r;

      if (store.musicPlaying && !musicWarningFired) {
        const dur = engine.getMusicDuration();
        const pos = engine.getMusicPosition();
        const remaining = dur - pos;
        if (dur > 16 && remaining > 0 && remaining <= 15) {
          musicWarningFired = true;
          engine.playWarningBeep();
          announce('Music ending soon');
        }
      }
    }, 50);

    removeStatusListener = window.api?.onStatus((status) => {
      if (status.connected !== undefined) store.connected = status.connected as boolean;
      if (status.streaming !== undefined) store.streaming = status.streaming as boolean;
      if (status.recording !== undefined) store.recording = status.recording as boolean;
      if (status.duration !== undefined) store.duration = status.duration as number;
      if (status.listeners !== undefined) store.listeners = status.listeners as number;
      if (status.error !== undefined) store.error = status.error as string | null;
      if (status.reconnecting !== undefined) store.reconnecting = status.reconnecting as boolean;
      if (status.hlsActive !== undefined) store.hlsActive = status.hlsActive as boolean;
    }) ?? null;

    const saved = await window.api?.loadSettings();
    if (saved) store.loadSettings(saved as Record<string, unknown>);
    settingsLoaded = true;

    // Apply saved audio settings
    engine.setEffects(store.effects);
    engine.setDucking(store.duckingEnabled, store.duckAmount);
    engine.setMicGain(store.micGain);
    engine.setSysGain(store.sysGain);
    engine.setMasterGain(store.masterGain);
    engine.setMusicVolume(store.musicVolume / 100);
    engine.setMicMuted(store.micMuted);
    engine.setSysMuted(store.sysAudioMuted);

    // Restore mic device — enumerate first, then check saved device still exists
    if (store.micDeviceId) {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach((t) => t.stop());
      } catch { /* permission denied — proceed */ }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      const found = audioInputs.some((d) => d.deviceId === store.micDeviceId);
      if (found) {
        await onMicChange(store.micDeviceId);
      } else {
        store.micDeviceId = '';
      }
    }

    // Restore system audio capture
    if (store.sysAudioEnabled) {
      try {
        await engine.enableSystemAudio();
      } catch {
        store.sysAudioEnabled = false;
      }
    }

    // Reload saved music file
    if (store.musicFilePath) {
      try {
        const buf = await window.api?.readBinaryFile(store.musicFilePath);
        if (buf) await engine.loadMusicFile(buf);
      } catch {
        store.musicFilePath = '';
        store.musicFileName = '';
      }
    }

    // Reload saved IR file
    if (store.irFilePath) {
      try {
        const buf = await window.api?.readBinaryFile(store.irFilePath);
        if (buf) await engine.loadImpulseResponse(buf);
      } catch {
        store.irFilePath = '';
        store.irFileName = '';
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('beforeunload', saveSettingsSync);
    removeShortcutListener = window.api?.onShortcut(handleGlobalShortcut) ?? null;
  });

  onDestroy(() => {
    clearInterval(meterInterval);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('beforeunload', saveSettingsSync);
    removeShortcutListener?.();
    removeStatusListener?.();
    engine?.destroy();
    saveSettingsSync();
  });

  function isInputFocused(): boolean {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (isInputFocused() && !e.ctrlKey) return;

    // Ctrl+Shift shortcuts (check before non-shift variants)
    if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault();
      toggleSysMute();
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      if (!momentaryDuckActive) {
        momentaryDuckActive = true;
        engine?.momentaryDuck(true);
      }
    // Ctrl-only shortcuts
    } else if (e.ctrlKey && e.key === 'm') {
      e.preventDefault();
      toggleMicMute();
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      store.duckingEnabled = !store.duckingEnabled;
      engine?.setDucking(store.duckingEnabled, store.duckAmount);
    } else if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (store.streaming) stopStream();
      else startStream();
    } else if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      if (store.recording) stopRecording();
      else startRecording();
    } else if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      loadMusicFile();
    } else if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      toggleMusicPlay();
    } else if (e.ctrlKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      adjustMusicVolume(+5);
    } else if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      adjustMusicVolume(-5);
    } else if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      announceMusicProgress();
    }
  }

  function handleKeyUp(e: KeyboardEvent): void {
    if (momentaryDuckActive && (e.key === 'D' || e.key === 'd' || e.key === 'Shift')) {
      momentaryDuckActive = false;
      engine?.momentaryDuck(false);
    }
  }

  function handleGlobalShortcut(action: string): void {
    switch (action) {
      case 'toggle-mic-mute':
        toggleMicMute();
        break;
      case 'toggle-sys-mute':
        toggleSysMute();
        break;
      case 'momentary-duck':
        engine?.momentaryDuck(true);
        setTimeout(() => engine?.momentaryDuck(false), 3000);
        break;
      case 'music-volume-up':
        adjustMusicVolume(+5);
        break;
      case 'music-volume-down':
        adjustMusicVolume(-5);
        break;
      case 'music-toggle-play':
        toggleMusicPlay();
        break;
    }
  }

  // --- Actions ---

  function announce(msg: string): void {
    muteAnnouncement = '';
    requestAnimationFrame(() => { muteAnnouncement = msg; });
  }

  function toggleMicMute(): void {
    store.micMuted = !store.micMuted;
    engine?.setMicMuted(store.micMuted);
    announce(store.micMuted ? 'Microphone muted' : 'Microphone unmuted');
  }

  function toggleSysMute(): void {
    store.sysAudioMuted = !store.sysAudioMuted;
    engine?.setSysMuted(store.sysAudioMuted);
    announce(store.sysAudioMuted ? 'System audio muted' : 'System audio unmuted');
  }

  async function onMicChange(deviceId: string): Promise<void> {
    try {
      await engine?.setMicDevice(deviceId);
      store.error = null;
    } catch (err) {
      store.error = `Mic error: ${err instanceof Error ? err.message : err}`;
    }
  }

  async function onSysToggle(enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        await engine?.enableSystemAudio();
      } else {
        engine?.disableSystemAudio();
      }
      store.error = null;
    } catch (err) {
      store.sysAudioEnabled = false;
      store.error = `System audio error: ${err instanceof Error ? err.message : err}`;
    }
  }

  function onEffectsChange(effects: MicEffects): void {
    engine?.setEffects(effects);
  }

  async function loadImpulseResponse(): Promise<void> {
    const result = await window.api?.showOpenDialog({
      title: 'Load Impulse Response',
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'aiff', 'aif', 'flac', 'ogg', 'mp3'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (result?.canceled || !result?.filePaths?.length) return;

    const filePath = result.filePaths[0];
    try {
      const arrayBuffer = await window.api?.readBinaryFile(filePath);
      if (arrayBuffer) {
        await engine?.loadImpulseResponse(arrayBuffer);
        store.irFilePath = filePath;
        store.irFileName = filePath.split(/[\\/]/).pop() ?? filePath;
        saveSettings();
      }
    } catch (err) {
      store.error = `IR load error: ${err instanceof Error ? err.message : err}`;
    }
  }

  function clearImpulseResponse(): void {
    engine?.resetImpulseResponse();
    store.irFilePath = '';
    store.irFileName = '';
    saveSettings();
  }

  async function loadMusicFile(): Promise<void> {
    const result = await window.api?.showOpenDialog({
      title: 'Open Audio File',
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'ogg', 'opus', 'wav', 'flac', 'aac', 'm4a'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (result?.canceled || !result?.filePaths?.length) return;

    const filePath = result.filePaths[0];
    try {
      const arrayBuffer = await window.api?.readBinaryFile(filePath);
      if (arrayBuffer && engine) {
        await engine.loadMusicFile(arrayBuffer);
        store.musicFilePath = filePath;
        store.musicFileName = filePath.split(/[\\/]/).pop() ?? filePath;
        store.musicPlaying = false;
        announce(`Loaded ${store.musicFileName}`);
      }
    } catch (err) {
      store.error = `Music load error: ${err instanceof Error ? err.message : err}`;
    }
  }

  function toggleMusicPlay(): void {
    if (!engine || !store.musicFileName) return;
    if (store.musicPlaying) {
      engine.pauseMusic();
      store.musicPlaying = false;
      announce('Music paused');
    } else {
      engine.playMusic();
      store.musicPlaying = engine.musicIsPlaying;
      if (store.musicPlaying) announce('Music playing');
    }
  }

  function setMusicVolume(v: number): void {
    engine?.setMusicVolume(v / 100);
  }

  function adjustMusicVolume(delta: number): void {
    const next = Math.max(0, Math.min(100, store.musicVolume + delta));
    if (next === store.musicVolume) {
      announce(`Music volume ${next}%`);
      return;
    }
    store.musicVolume = next;
    engine?.setMusicVolume(next / 100);
    announce(`Music volume ${next}%`);
  }

  function formatHms(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${m}:${String(s).padStart(2, '0')}`;
  }

  function announceMusicProgress(): void {
    if (!engine || !store.musicFileName) {
      announce('No music file loaded');
      return;
    }
    const duration = engine.getMusicDuration();
    if (duration <= 0) {
      announce('No music file loaded');
      return;
    }
    const position = engine.getMusicPosition();
    const percent = Math.round((position / duration) * 100);
    const remaining = duration - position;
    announce(`${percent}%, ${formatHms(remaining)} remaining`);
  }

  // Fire a single warning beep when music has ~15s left.
  let musicWarningFired = false;
  $effect(() => {
    if (!store.musicPlaying) {
      musicWarningFired = false;
    }
  });

  async function startStream(): Promise<void> {
    if (!engine) return;
    store.error = null;

    if (!store.streamUrl) {
      store.error = 'No server URL configured — set it on the Server tab';
      return;
    }

    try {
      new URL(store.streamUrl);
    } catch {
      store.error = `Invalid server URL: "${store.streamUrl}" — expected http(s)://host:port/mount`;
      return;
    }

    if (!store.streamPassword) {
      store.error = 'No password configured — set it on the Server tab';
      return;
    }

    const encoderConfig = {
      format: store.streamFormat,
      bitrate: store.streamBitrate,
      sampleRate: engine.sampleRate,
      channels: 2,
    };
    await window.api?.startEncoder(encoderConfig);
    engine.setCaptureActive(true);

    let result: { success?: boolean; error?: string } | undefined;
    try {
      result = await window.api?.connectIcecast({
        url: store.streamUrl,
        username: store.streamUsername,
        password: store.streamPassword,
        format: store.streamFormat,
        streamName: store.streamName,
      });
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!result?.success) {
      store.error = result?.error ?? 'Connection failed — check server settings';
      await window.api?.stopEncoder();
      engine.setCaptureActive(false);
      return;
    }

    if (store.hlsEnabled && store.hlsPath) {
      await window.api?.startHls({
        path: store.hlsPath,
        format: store.streamFormat,
        bitrate: store.streamBitrate,
        sampleRate: engine.sampleRate,
        channels: 2,
      });
    }

    saveSettings();
  }

  async function stopStream(): Promise<void> {
    engine?.setCaptureActive(false);
    await window.api?.disconnectIcecast();
    await window.api?.stopEncoder();
    if (store.hlsActive) await window.api?.stopHls();
    store.streaming = false;
    store.connected = false;
  }

  async function startRecording(): Promise<void> {
    const result = await window.api?.showSaveDialog({
      title: 'Save Recording',
      defaultPath: `recording-${Date.now()}.${store.streamFormat}`,
      filters: [
        { name: 'Audio', extensions: [store.streamFormat] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result?.canceled || !result?.filePath) return;

    if (!store.streaming) {
      const encoderConfig = {
        format: store.streamFormat,
        bitrate: store.streamBitrate,
        sampleRate: engine?.sampleRate ?? 48000,
        channels: 2,
      };
      await window.api?.startEncoder(encoderConfig);
      engine?.setCaptureActive(true);
    }

    await window.api?.startRecording({ path: result.filePath });
  }

  async function stopRecording(): Promise<void> {
    await window.api?.stopRecording();
    if (!store.streaming) {
      engine?.setCaptureActive(false);
      await window.api?.stopEncoder();
    }
  }

  async function startHls(): Promise<void> {
    if (!store.hlsPath || !engine) return;
    await window.api?.startHls({
      path: store.hlsPath,
      format: store.streamFormat,
      bitrate: store.streamBitrate,
      sampleRate: engine.sampleRate,
      channels: 2,
    });
  }

  async function stopHls(): Promise<void> {
    await window.api?.stopHls();
  }

  async function saveSettings(): Promise<void> {
    await window.api?.saveSettings(store.toSettings());
  }

  function saveSettingsSync(): void {
    window.api?.saveSettingsSync(store.toSettings());
  }

  let settingsLoaded = $state(false);

  // Event-based status announcements (transitions only, not ticks)
  let prevConnected = false;
  let prevStreaming = false;
  let prevRecording = false;
  $effect(() => {
    const c = store.connected;
    const s = store.streaming;
    const r = store.recording;
    if (c !== prevConnected) {
      announce(c ? 'Connected to server' : 'Disconnected from server');
      prevConnected = c;
    }
    if (s !== prevStreaming) {
      announce(s ? 'Streaming started' : 'Streaming stopped');
      prevStreaming = s;
    }
    if (r !== prevRecording) {
      announce(r ? 'Recording started' : 'Recording stopped');
      prevRecording = r;
    }
  });

  // Mic silence detection — announce after ~3s of continuous silence,
  // and again when audio returns. Level threshold is linear amplitude.
  const SILENCE_THRESHOLD = 0.005;
  const SILENCE_DELAY_MS = 3000;
  let micSilent = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const level = store.micLevel;
    const hasMic = !!store.micDeviceId && !store.micMuted;
    if (!hasMic) {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      micSilent = false;
      return;
    }
    if (level < SILENCE_THRESHOLD) {
      if (!micSilent && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          micSilent = true;
          silenceTimer = null;
          announce('No microphone input detected');
        }, SILENCE_DELAY_MS);
      }
    } else {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (micSilent) {
        micSilent = false;
        announce('Microphone input detected');
      }
    }
  });

  let saveDebounce: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const snapshot = store.toSettings();
    if (!settingsLoaded) return;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
      window.api?.saveSettings(snapshot);
    }, 300);
  });

  const canStream = $derived(store.streamUrl.length > 0 && store.streamPassword.length > 0);
</script>

<header class="app-header">
  <h1>WebIce</h1>
  {#if store.streaming}
    <span class="row gap-sm">
      <span class="status-dot live" aria-label="Live"></span>
      <strong>LIVE</strong>
      <span class="text-muted" aria-hidden="true">{store.durationFormatted}</span>
    </span>
  {/if}
</header>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="tab-bar" role="tablist" aria-label="Application sections" onkeydown={handleTabKeydown}>
  {#each tabs as tab}
    <button
      id="tab-{tab.id}"
      role="tab"
      aria-selected={activeTab === tab.id}
      aria-controls="panel-{tab.id}"
      tabindex={activeTab === tab.id ? 0 : -1}
      onclick={() => (activeTab = tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<main class="app-body">
  <div
    id="panel-main"
    role="tabpanel"
    aria-labelledby="tab-main"
    tabindex="0"
    class="tab-panel"
    hidden={activeTab !== 'main'}
  >
    <DeviceSelector
      {onMicChange}
      {onSysToggle}
      onMicGainChange={(v) => engine?.setMicGain(v)}
      onSysGainChange={(v) => engine?.setSysGain(v)}
    />

    <MixerPanel
      onMasterGainChange={(v) => engine?.setMasterGain(v)}
      onDuckingChange={(e) => engine?.setDucking(e, store.duckAmount)}
      onDuckAmountChange={(v) => engine?.setDucking(store.duckingEnabled, v)}
    />

    <MusicPlayerPanel
      onLoadFile={loadMusicFile}
      onTogglePlay={toggleMusicPlay}
      onVolumeChange={setMusicVolume}
      onAnnounceProgress={announceMusicProgress}
    />

    <section class="panel" aria-label="Transport controls">
      <div class="actions row gap-md">
        <button
          class="btn-icon-lg"
          class:muted={store.micMuted}
          onclick={toggleMicMute}
          aria-label={store.micMuted ? 'Unmute microphone (Ctrl+M)' : 'Mute microphone (Ctrl+M)'}
          title="Mic mute (Ctrl+M)"
        >
          {store.micMuted ? '🔇' : '🎤'}
        </button>

        <button
          class="btn-icon-lg"
          class:muted={store.sysAudioMuted}
          onclick={toggleSysMute}
          disabled={!store.sysAudioEnabled}
          aria-label={store.sysAudioMuted ? 'Unmute system audio (Ctrl+Shift+M)' : 'Mute system audio (Ctrl+Shift+M)'}
          title="System audio mute (Ctrl+Shift+M)"
        >
          {store.sysAudioMuted ? '🔇' : '🔊'}
        </button>

        {#if store.streaming}
          <button class="btn-danger" onclick={stopStream} aria-label="Stop streaming">
            <span class="status-dot live" aria-hidden="true"></span> Stop Stream
          </button>
        {:else}
          <button
            class="btn-primary"
            onclick={startStream}
            disabled={!canStream}
            aria-label="Start streaming to Icecast"
          >
            Start Stream <kbd>Ctrl+S</kbd>
          </button>
        {/if}

        {#if store.recording}
          <button class="btn-danger" onclick={stopRecording} aria-label="Stop recording">
            <span class="status-dot live" aria-hidden="true"></span> Stop Rec
          </button>
        {:else}
          <button class="btn-outline" onclick={startRecording} aria-label="Start recording to file">
            Record <kbd>Ctrl+R</kbd>
          </button>
        {/if}

        {#if store.hlsEnabled}
          {#if store.hlsActive}
            <button class="btn-danger" onclick={stopHls} aria-label="Stop HLS output">
              Stop HLS
            </button>
          {:else}
            <button
              class="btn-outline"
              onclick={startHls}
              disabled={!store.hlsPath}
              aria-label="Start HLS output"
            >
              Start HLS
            </button>
          {/if}
        {/if}

        {#if store.streaming && store.listeners >= 0}
          <span class="listeners text-sm" aria-live="polite">
            Listeners: <strong>{store.listeners}</strong>
          </span>
        {/if}
      </div>
    </section>
  </div>

  <div
    id="panel-server"
    role="tabpanel"
    aria-labelledby="tab-server"
    tabindex="0"
    class="tab-panel"
    hidden={activeTab !== 'server'}
  >
    <ServerPanel onSave={saveSettings} />
  </div>

  <div
    id="panel-recording"
    role="tabpanel"
    aria-labelledby="tab-recording"
    tabindex="0"
    class="tab-panel"
    hidden={activeTab !== 'recording'}
  >
    <RecordingPanel />
  </div>

  <div
    id="panel-effects"
    role="tabpanel"
    aria-labelledby="tab-effects"
    tabindex="0"
    class="tab-panel"
    hidden={activeTab !== 'effects'}
  >
    <EffectsPanel {onEffectsChange} onLoadImpulse={loadImpulseResponse} onClearImpulse={clearImpulseResponse} />
  </div>

  <div class="sr-only" role="status" aria-live="assertive" aria-atomic="true">
    {muteAnnouncement}
  </div>
</main>

<StatusBar />

<style>
  .actions {
    flex-wrap: wrap;
  }

  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .listeners {
    margin-left: auto;
    color: var(--text-secondary);
  }
</style>
