<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';
  import VuMeter from './VuMeter.svelte';

  let {
    onMicChange,
    onSysToggle,
    onMicGainChange,
    onSysGainChange,
  }: {
    onMicChange: (id: string) => void;
    onSysToggle: (enabled: boolean) => void;
    onMicGainChange: (v: number) => void;
    onSysGainChange: (v: number) => void;
  } = $props();

  async function refreshDevices() {
    try {
      // Trigger permission prompt if needed
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied - proceed with what we can enumerate
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.availableDevices = devices.filter((d) => d.kind === 'audioinput');
  }

  $effect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  });

  function handleMicSelect(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    store.micDeviceId = value;
    onMicChange(value);
  }

  function handleSysToggle() {
    store.sysAudioEnabled = !store.sysAudioEnabled;
    onSysToggle(store.sysAudioEnabled);
  }

  function handleMicGain(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.micGain = v;
    onMicGainChange(v);
  }

  function handleSysGain(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.sysGain = v;
    onSysGainChange(v);
  }
</script>

<section class="panel" aria-labelledby="sources-heading">
  <h2 id="sources-heading">{i18n.t('sources.heading')}</h2>

  <!-- Microphone -->
  <div class="source-block">
    <div class="col gap-sm">
      <label for="mic-select">{i18n.t('sources.microphone')}</label>
      <select id="mic-select" value={store.micDeviceId} onchange={handleMicSelect}>
        <option value="">{i18n.t('sources.none')}</option>
        {#each store.availableDevices as device}
          <option value={device.deviceId}>
            {device.label || `Mic ${device.deviceId.slice(0, 8)}`}
          </option>
        {/each}
      </select>
    </div>

    <div class="row gap-md" style="margin-top: 8px">
      <label for="mic-gain" class="sr-only">{i18n.t('sources.micGain')}</label>
      <input
        id="mic-gain"
        type="range"
        min="0"
        max="2"
        step="0.01"
        value={store.micGain}
        oninput={handleMicGain}
        aria-label={i18n.t('sources.micGain')}
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.micGain * 100)}%</span>
    </div>

    <VuMeter level={store.micLevel} label={i18n.t('sources.micLevel')} />
  </div>

  <!-- System Audio -->
  <div class="source-block" style="margin-top: 16px">
    <div class="row gap-md">
      <label class="row gap-sm" style="cursor: pointer">
        <input type="checkbox" checked={store.sysAudioEnabled} onchange={handleSysToggle} />
        {i18n.t('sources.systemAudio')}
      </label>
    </div>

    {#if store.sysAudioEnabled}
      <div class="row gap-md" style="margin-top: 8px">
        <label for="sys-gain" class="sr-only">{i18n.t('sources.sysGain')}</label>
        <input
          id="sys-gain"
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={store.sysGain}
          oninput={handleSysGain}
          aria-label={i18n.t('sources.sysGain')}
        />
        <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.sysGain * 100)}%</span>
      </div>
    {/if}
  </div>
</section>

<style>
  .source-block {
    padding-bottom: 8px;
  }
</style>
