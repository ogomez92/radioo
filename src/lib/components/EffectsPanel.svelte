<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import type { MicEffects } from '../types';

  let {
    onEffectsChange,
    onLoadImpulse,
    onClearImpulse,
  }: {
    onEffectsChange: (effects: MicEffects) => void;
    onLoadImpulse: () => void;
    onClearImpulse: () => void;
  } = $props();

  function toggle(key: keyof MicEffects) {
    store.effects[key] = !store.effects[key];
    onEffectsChange({ ...store.effects });
  }

  const effects: { key: keyof MicEffects; label: string; description: string }[] = [
    { key: 'boost', label: 'Boost', description: '+6 dB gain increase' },
    { key: 'noiseGate', label: 'Gate', description: 'Noise gate — cuts silence' },
    { key: 'compressor', label: 'Compressor', description: 'Dynamic range control' },
    { key: 'presence', label: 'Presence', description: '2–5 kHz clarity boost' },
    { key: 'megaphone', label: 'Megaphone', description: 'Lo-fi bandpass filter' },
    { key: 'reverb', label: 'Reverb', description: 'Convolution reverb' },
  ];
</script>

<section class="panel" aria-labelledby="effects-heading">
  <h2 id="effects-heading">Mic Effects</h2>

  <div class="effects-grid" role="group" aria-label="Microphone effects toggles">
    {#each effects as fx}
      <button
        class="toggle"
        role="switch"
        aria-checked={store.effects[fx.key]}
        aria-label="{fx.label}: {fx.description}"
        title={fx.description}
        onclick={() => toggle(fx.key)}
      >
        <span class="toggle-indicator" aria-hidden="true">{store.effects[fx.key] ? '●' : '○'}</span>
        {fx.label}
      </button>
    {/each}
  </div>

  <p class="text-sm text-muted" style="margin-top: 10px">
    Chain: Boost → Gate → Compressor → Presence → Megaphone → Reverb → Limiter
  </p>
</section>

<section class="panel" aria-labelledby="ir-heading">
  <h2 id="ir-heading">Impulse Response</h2>

  <p class="text-sm text-muted" style="margin-bottom: 10px">
    Load a WAV/AIFF impulse response file for convolution reverb. Without one, a synthetic room IR is used.
  </p>

  <div class="row gap-md">
    <button class="btn-outline" onclick={onLoadImpulse} aria-label="Load impulse response file">
      Load IR File
    </button>

    {#if store.irFileName}
      <span class="text-sm ir-name" title={store.irFilePath}>{store.irFileName}</span>
      <button
        class="btn-outline text-sm"
        onclick={onClearImpulse}
        aria-label="Clear impulse response and use default"
      >
        Clear
      </button>
    {:else}
      <span class="text-sm text-muted">Using built-in synthetic IR</span>
    {/if}
  </div>
</section>

<style>
  .effects-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .toggle-indicator {
    font-size: 10px;
  }

  .ir-name {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
</style>
