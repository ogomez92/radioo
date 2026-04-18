<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';
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

  const effects = $derived<{ key: keyof MicEffects; label: string; description: string }[]>([
    { key: 'boost', label: i18n.t('effects.boost'), description: i18n.t('effects.boostDesc') },
    { key: 'noiseGate', label: i18n.t('effects.gate'), description: i18n.t('effects.gateDesc') },
    { key: 'compressor', label: i18n.t('effects.compressor'), description: i18n.t('effects.compressorDesc') },
    { key: 'presence', label: i18n.t('effects.presence'), description: i18n.t('effects.presenceDesc') },
    { key: 'megaphone', label: i18n.t('effects.megaphone'), description: i18n.t('effects.megaphoneDesc') },
    { key: 'reverb', label: i18n.t('effects.reverb'), description: i18n.t('effects.reverbDesc') },
  ]);
</script>

<section class="panel" aria-labelledby="effects-heading">
  <h2 id="effects-heading">{i18n.t('effects.heading')}</h2>

  <div class="effects-grid" role="group" aria-label={i18n.t('effects.aria')}>
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
    {i18n.t('effects.chain')}
  </p>
</section>

<section class="panel" aria-labelledby="ir-heading">
  <h2 id="ir-heading">{i18n.t('effects.irHeading')}</h2>

  <p class="text-sm text-muted" style="margin-bottom: 10px">
    {i18n.t('effects.irDesc')}
  </p>

  <div class="row gap-md">
    <button class="btn-outline" onclick={onLoadImpulse} aria-label={i18n.t('effects.loadIrAria')}>
      {i18n.t('effects.loadIr')}
    </button>

    {#if store.irFileName}
      <span class="text-sm ir-name" title={store.irFilePath}>{store.irFileName}</span>
      <button
        class="btn-outline text-sm"
        onclick={onClearImpulse}
        aria-label={i18n.t('effects.clearIrAria')}
      >
        {i18n.t('effects.clearIr')}
      </button>
    {:else}
      <span class="text-sm text-muted">{i18n.t('effects.usingBuiltIn')}</span>
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
