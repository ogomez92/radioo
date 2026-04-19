<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { AudioEngine } from './lib/audio/engine';
  import { store } from './lib/stores/app-store.svelte';
  import { i18n } from './lib/i18n/i18n.svelte';
  import type { MicEffects } from './lib/types';
  import SourcesPanel from './lib/components/SourcesPanel.svelte';
  import EffectsPanel from './lib/components/EffectsPanel.svelte';
  import MixerPanel from './lib/components/MixerPanel.svelte';
  import MusicPlayerPanel from './lib/components/MusicPlayerPanel.svelte';
  import ServerPanel from './lib/components/ServerPanel.svelte';
  import RecordingPanel from './lib/components/RecordingPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import SettingsPanel from './lib/components/SettingsPanel.svelte';
  import './app.css';

  let engine: AudioEngine | null = null;
  let meterInterval: ReturnType<typeof setInterval>;
  let removeStatusListener: (() => void) | null = null;
  let removeShortcutListener: (() => void) | null = null;
  let removeSyscapPcmListener: (() => void) | null = null;
  let removeSyscapEndedListener: (() => void) | null = null;
  let momentaryDuckActive = false;
  let muteAnnouncement = $state('');
  let wasConnected = false;

  // Single hook: any disconnect (manual, icecast drop, error) flips store.connected
  // from true → false. Play a 1s local beep so the operator is alerted.
  $effect(() => {
    const connected = store.connected;
    if (wasConnected && !connected) engine?.playDisconnectBeep();
    wasConnected = connected;
  });

  type TabId = 'main' | 'server' | 'recording' | 'effects' | 'settings';
  let activeTab = $state<TabId>('main');

  const tabs = $derived<{ id: TabId; label: string }[]>([
    { id: 'main', label: i18n.t('tabs.main') },
    { id: 'server', label: i18n.t('tabs.server') },
    { id: 'recording', label: i18n.t('tabs.recording') },
    { id: 'effects', label: i18n.t('tabs.effects') },
    { id: 'settings', label: i18n.t('tabs.settings') },
  ]);

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
    // Move focus to the first tab so keyboard / screen-reader users land
    // inside the app immediately instead of at document start.
    requestAnimationFrame(() => {
      document.getElementById(`tab-${activeTab}`)?.focus();
    });

    engine = new AudioEngine();
    try {
      await engine.init((pcm: Float32Array) => {
        window.api?.sendAudioData(pcm.buffer as ArrayBuffer);
      });
      const ctx = engine.audioContext;
      if (ctx) {
        // eslint-disable-next-line no-console
        console.log(
          '[audio] ctx.sampleRate=%d baseLatency=%f outputLatency=%f',
          ctx.sampleRate,
          ctx.baseLatency,
          ctx.outputLatency ?? -1,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.error = `Audio engine init failed: ${msg}`;
      console.error('[radioo] engine.init failed', err);
      return;
    }
    engine.setMusicEndedCallback(() => {
      store.musicPlaying = false;
      announce(i18n.t('announce.musicFinished'));
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
          announce(i18n.t('announce.musicEndingSoon'));
        }
      }
    }, 50);

    removeStatusListener = window.api?.onStatus((status) => {
      if (status.connected !== undefined) store.connected = status.connected as boolean;
      if (status.streaming !== undefined) store.streaming = status.streaming as boolean;
      if (status.recording !== undefined) store.recording = status.recording as boolean;
      if (status.duration !== undefined) store.duration = status.duration as number;
      if (status.listeners !== undefined) store.listeners = status.listeners as number;
      if (status.listenersError !== undefined) store.listenersError = status.listenersError as string | null;
      if (status.error !== undefined) store.error = status.error as string | null;
      if (status.reconnecting !== undefined) store.reconnecting = status.reconnecting as boolean;
      if (status.hlsActive !== undefined) store.hlsActive = status.hlsActive as boolean;
    }) ?? null;

    const saved = await window.api?.loadSettings();
    if (saved) store.loadSettings(saved as Record<string, unknown>);
    i18n.setLang(store.language);
    settingsLoaded = true;

    // Apply saved audio settings
    engine.setEffects(store.effects);
    engine.setDucking(store.duckingEnabled, store.duckAmount);
    engine.setMicGain(store.micGain);
    engine.setSysGain(store.sysGain);
    engine.setMasterGain(store.masterGain);
    engine.setMusicVolume(store.musicVolume / 100);
    engine.setMicMuted(store.micMuted);

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

    // Per-process system audio capture
    const syscapSupported = (await window.api?.syscapSupported()) ?? false;
    store.syscapSupported = syscapSupported;
    if (!syscapSupported) store.syscapEnabled = false;

    removeSyscapPcmListener = window.api?.onSyscapPcm(({ pid, buffer }) => {
      engine?.pushSysPcm(pid, buffer);
    }) ?? null;

    removeSyscapEndedListener = window.api?.onSyscapEnded(({ pid }) => {
      engine?.detachSysSource(pid);
    }) ?? null;

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
    removeSyscapPcmListener?.();
    removeSyscapEndedListener?.();
    window.api?.syscapStop();
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
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      announceListenerCount();
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
      case 'toggle-screen-reader':
        toggleScreenReader();
        break;
    }
  }

  async function toggleScreenReader(): Promise<void> {
    if (!store.syscapSupported) return;
    const pid = await window.api?.syscapScreenReaderPid();
    if (!pid) {
      announce(i18n.t('announce.screenReaderNotFound'));
      return;
    }
    // Make sure capture is on — otherwise the shortcut would silently do nothing.
    if (!store.syscapEnabled) store.syscapEnabled = true;

    // In "Capture system audio" (all) mode, the natural interpretation of
    // toggling SR is "silence it": promote to exclude + add the SR PID.
    if (store.syscapMode === 'all') {
      store.syscapMode = 'exclude';
      store.syscapPids = [pid];
      store.syscapPidNames = { ...store.syscapPidNames, [pid]: 'Screen reader' };
      announce(i18n.t('announce.screenReaderAdded', { mode: store.syscapMode }));
      return;
    }

    if (store.syscapPids.includes(pid)) {
      store.syscapPids = store.syscapPids.filter((p) => p !== pid);
      const { [pid]: _, ...rest } = store.syscapPidNames;
      store.syscapPidNames = rest;
      announce(i18n.t('announce.screenReaderRemoved', { mode: store.syscapMode }));
    } else {
      store.syscapPids = [...store.syscapPids, pid];
      store.syscapPidNames = { ...store.syscapPidNames, [pid]: 'Screen reader' };
      announce(i18n.t('announce.screenReaderAdded', { mode: store.syscapMode }));
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
    announce(store.micMuted ? i18n.t('announce.micMuted') : i18n.t('announce.micUnmuted'));
  }

  function toggleSysMute(): void {
    if (!store.syscapSupported) return;
    store.syscapEnabled = !store.syscapEnabled;
    announce(store.syscapEnabled ? i18n.t('announce.sysUnmuted') : i18n.t('announce.sysMuted'));
  }

  async function onMicChange(deviceId: string): Promise<void> {
    try {
      await engine?.setMicDevice(deviceId);
      store.error = null;
    } catch (err) {
      store.error = i18n.t('errors.micError', { msg: err instanceof Error ? err.message : String(err) });
    }
  }

  // Push syscap desired targets to the main process whenever the config changes.
  // Also detach any renderer-side worklet nodes that no longer map to an active
  // sidecar so the Web Audio graph stays in sync.
  $effect(() => {
    if (!settingsLoaded) return;
    const enabled = store.syscapEnabled && store.syscapSupported;
    const mode = store.syscapMode;
    const pids = [...store.syscapPids];

    if (!enabled) {
      // When syscap is off we need to explicitly stop sidecars. Calling
      // syscapSetTargets with pids:[] isn't enough — 'all' mode spawns a
      // sidecar regardless of pids.
      window.api?.syscapStop().catch(() => { /* errors surface via status:update */ });
    } else {
      window.api?.syscapSetTargets(mode, pids).catch(() => { /* errors surface via status:update */ });
    }

    if (engine) {
      const allowed = enabled ? new Set(mode === 'all' ? [0] : pids) : new Set<number>();
      for (const p of engine.activeSysPids) {
        if (!allowed.has(p)) engine.detachSysSource(p);
      }
    }
  });

  function onEffectsChange(effects: MicEffects): void {
    engine?.setEffects(effects);
  }

  async function loadImpulseResponse(): Promise<void> {
    const result = await window.api?.showOpenDialog({
      title: i18n.t('dialogs.loadIrTitle'),
      filters: [
        { name: i18n.t('dialogs.audioFiles'), extensions: ['wav', 'aiff', 'aif', 'flac', 'ogg', 'mp3'] },
        { name: i18n.t('dialogs.allFiles'), extensions: ['*'] },
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
      store.error = i18n.t('errors.irLoad', { msg: err instanceof Error ? err.message : String(err) });
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
      title: i18n.t('dialogs.openAudioTitle'),
      filters: [
        { name: i18n.t('dialogs.audioFiles'), extensions: ['mp3', 'ogg', 'opus', 'wav', 'flac', 'aac', 'm4a'] },
        { name: i18n.t('dialogs.allFiles'), extensions: ['*'] },
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
        // Re-apply the saved volume to the engine. loadMusicFile doesn't
        // touch musicGain, but if the Web Audio graph was ever rebuilt
        // (HMR, context restart) the gain could be out of sync with the
        // store's 0–100 value.
        engine.setMusicVolume(store.musicVolume / 100);
        announce(i18n.t('announce.musicLoaded', { name: store.musicFileName }));
        // Auto-play: user just picked a file, assume they want to hear it.
        toggleMusicPlay();
      }
    } catch (err) {
      store.error = i18n.t('errors.musicLoad', { msg: err instanceof Error ? err.message : String(err) });
    }
  }

  function toggleMusicPlay(): void {
    if (!engine || !store.musicFileName) return;
    if (store.musicPlaying) {
      engine.pauseMusic();
      store.musicPlaying = false;
      announce(i18n.t('announce.musicPaused'));
    } else {
      engine.playMusic();
      store.musicPlaying = engine.musicIsPlaying;
      if (store.musicPlaying) {
        // Auto-mute system audio if the setting is on. Only fires on the
        // play transition — user can still unmute mid-playback, and we never
        // unmute automatically when the track ends.
        if (store.muteSysWhileMusicPlaying && store.syscapEnabled) {
          store.syscapEnabled = false;
        }
        announce(i18n.t('announce.musicPlaying'));
      }
    }
  }

  function setMusicVolume(v: number): void {
    engine?.setMusicVolume(v / 100);
  }

  function adjustMusicVolume(delta: number): void {
    const next = Math.max(0, Math.min(100, store.musicVolume + delta));
    if (next === store.musicVolume) {
      announce(i18n.t('announce.musicVolume', { percent: next }));
      return;
    }
    store.musicVolume = next;
    engine?.setMusicVolume(next / 100);
    announce(i18n.t('announce.musicVolume', { percent: next }));
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
      announce(i18n.t('announce.noMusicFile'));
      return;
    }
    const duration = engine.getMusicDuration();
    if (duration <= 0) {
      announce(i18n.t('announce.noMusicFile'));
      return;
    }
    const position = engine.getMusicPosition();
    const percent = Math.round((position / duration) * 100);
    const remaining = duration - position;
    announce(i18n.t('announce.musicProgress', { percent, time: formatHms(remaining) }));
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
      store.error = i18n.t('errors.noUrl');
      return;
    }

    try {
      new URL(store.streamUrl);
    } catch {
      store.error = i18n.t('errors.invalidUrl', { url: store.streamUrl });
      return;
    }

    if (!store.streamPassword) {
      store.error = i18n.t('errors.noPassword');
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
        listenerCountUrl: store.listenerCountUrl,
      });
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!result?.success) {
      store.error = result?.error ?? i18n.t('errors.connectionFailed');
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
      title: i18n.t('dialogs.saveRecordingTitle'),
      defaultPath: `recording-${Date.now()}.${store.streamFormat}`,
      filters: [
        { name: i18n.t('dialogs.audio'), extensions: [store.streamFormat] },
        { name: i18n.t('dialogs.allFiles'), extensions: ['*'] },
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
  let prevListeners = 0;

  $effect(() => {
    const count = store.listeners;
    // Reset baseline when the stream stops or we have no valid count.
    if (!store.streaming || count < 0) {
      prevListeners = 0;
      return;
    }
    if (count > prevListeners) engine?.playListenerUpBeep();
    else if (count < prevListeners) engine?.playListenerDownBeep();
    prevListeners = count;
  });

  function announceListenerCount(): void {
    if (store.listenersError) {
      announce(i18n.t('announce.listenersPollError'));
      return;
    }
    if (!store.streaming) {
      announce(i18n.t('announce.listenersNotStreaming'));
      return;
    }
    if (store.listeners < 0) {
      announce(i18n.t('announce.listenersUnknown'));
      return;
    }
    announce(i18n.t('announce.listenersCount', { count: store.listeners }));
  }
  $effect(() => {
    const c = store.connected;
    const s = store.streaming;
    const r = store.recording;
    if (c !== prevConnected) {
      announce(c ? i18n.t('announce.connected') : i18n.t('announce.disconnected'));
      prevConnected = c;
    }
    if (s !== prevStreaming) {
      announce(s ? i18n.t('announce.streamStarted') : i18n.t('announce.streamStopped'));
      prevStreaming = s;
    }
    if (r !== prevRecording) {
      announce(r ? i18n.t('announce.recStarted') : i18n.t('announce.recStopped'));
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
          announce(i18n.t('announce.noMicInput'));
        }, SILENCE_DELAY_MS);
      }
    } else {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (micSilent) {
        micSilent = false;
        announce(i18n.t('announce.micInputDetected'));
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
  <h1>{i18n.t('app.title')}</h1>
  {#if store.streaming}
    <span class="row gap-sm">
      <span class="status-dot live" aria-label={i18n.t('status.live')}></span>
      <strong>{i18n.t('app.live')}</strong>
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
    class="tab-panel"
    hidden={activeTab !== 'main'}
  >
    <SourcesPanel
      {onMicChange}
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

    <section class="panel" aria-label={i18n.t('transport.aria')}>
      <div class="actions row gap-md">
        <button
          class="btn-icon-lg"
          class:muted={store.micMuted}
          onclick={toggleMicMute}
          aria-label={store.micMuted ? i18n.t('transport.unmuteMic', { key: 'Ctrl+M' }) : i18n.t('transport.muteMic', { key: 'Ctrl+M' })}
          title={i18n.t('transport.muteMic', { key: 'Ctrl+M' })}
        >
          {store.micMuted ? '🔇' : '🎤'}
        </button>

        {#if store.streaming}
          <button class="btn-danger" onclick={stopStream} aria-label={i18n.t('transport.stopStreamAria')}>
            <span class="status-dot live" aria-hidden="true"></span> {i18n.t('transport.stopStream')}
          </button>
        {:else}
          <button
            class="btn-primary"
            onclick={startStream}
            disabled={!canStream}
            aria-label={i18n.t('transport.startStreamAria')}
          >
            {i18n.t('transport.startStream')} <kbd>Ctrl+S</kbd>
          </button>
        {/if}

        {#if store.recording}
          <button class="btn-danger" onclick={stopRecording} aria-label={i18n.t('transport.stopRecordingAria')}>
            <span class="status-dot live" aria-hidden="true"></span> {i18n.t('transport.stopRec')}
          </button>
        {:else}
          <button class="btn-outline" onclick={startRecording} aria-label={i18n.t('transport.startRecordingAria')}>
            {i18n.t('transport.record')} <kbd>Ctrl+R</kbd>
          </button>
        {/if}

        {#if store.hlsEnabled}
          {#if store.hlsActive}
            <button class="btn-danger" onclick={stopHls} aria-label={i18n.t('transport.stopHlsAria')}>
              {i18n.t('transport.stopHls')}
            </button>
          {:else}
            <button
              class="btn-outline"
              onclick={startHls}
              disabled={!store.hlsPath}
              aria-label={i18n.t('transport.startHlsAria')}
            >
              {i18n.t('transport.startHls')}
            </button>
          {/if}
        {/if}

        <!-- Always rendered while streaming so the live region stays stable and
             updates reliably, whether the poll succeeds, fails, or is 0. -->
        {#if store.streaming}
          <span
            class="listeners text-sm"
            class:listeners-error={store.listenersError}
            aria-live="polite"
            aria-atomic="true"
          >
            {#if store.listenersError}
              {i18n.t('transport.listenersError')}
            {:else if store.listeners >= 0}
              {i18n.t('transport.listeners', { count: store.listeners })}
            {:else}
              {i18n.t('transport.listenersPending')}
            {/if}
          </span>
        {/if}
      </div>
    </section>
  </div>

  <div
    id="panel-server"
    role="tabpanel"
    aria-labelledby="tab-server"
    class="tab-panel"
    hidden={activeTab !== 'server'}
  >
    <ServerPanel onSave={saveSettings} />
  </div>

  <div
    id="panel-recording"
    role="tabpanel"
    aria-labelledby="tab-recording"
    class="tab-panel"
    hidden={activeTab !== 'recording'}
  >
    <RecordingPanel />
  </div>

  <div
    id="panel-effects"
    role="tabpanel"
    aria-labelledby="tab-effects"
    class="tab-panel"
    hidden={activeTab !== 'effects'}
  >
    <EffectsPanel {onEffectsChange} onLoadImpulse={loadImpulseResponse} onClearImpulse={clearImpulseResponse} />
  </div>

  <div
    id="panel-settings"
    role="tabpanel"
    aria-labelledby="tab-settings"
    class="tab-panel"
    hidden={activeTab !== 'settings'}
  >
    <SettingsPanel />
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
  .listeners-error {
    color: var(--danger, #e66);
  }
</style>
