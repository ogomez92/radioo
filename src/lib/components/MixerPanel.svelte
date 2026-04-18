<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';
  import VuMeter from './VuMeter.svelte';

  let {
    onMasterGainChange,
    onDuckingChange,
    onDuckAmountChange,
  }: {
    onMasterGainChange: (v: number) => void;
    onDuckingChange: (enabled: boolean) => void;
    onDuckAmountChange: (v: number) => void;
  } = $props();

  function handleMaster(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.masterGain = v;
    onMasterGainChange(v);
  }

  function handleDuckToggle() {
    store.duckingEnabled = !store.duckingEnabled;
    onDuckingChange(store.duckingEnabled);
  }

  function handleDuckAmount(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.duckAmount = v;
    onDuckAmountChange(v);
  }
</script>

<section class="panel" aria-labelledby="mixer-heading">
  <h2 id="mixer-heading">{i18n.t('mixer.heading')}</h2>

  <div class="col gap-sm">
    <div class="row gap-md">
      <label for="master-gain" style="min-width: 52px">{i18n.t('mixer.master')}</label>
      <input
        id="master-gain"
        type="range"
        min="0"
        max="2"
        step="0.01"
        value={store.masterGain}
        oninput={handleMaster}
        aria-label={i18n.t('mixer.masterAria')}
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.masterGain * 100)}%</span>
    </div>

    <VuMeter level={store.masterLevelL} label={i18n.t('mixer.masterLevel')} />
  </div>

  <div class="ducking-section" style="margin-top: 16px">
    <h2 id="ducking-heading">{i18n.t('mixer.ducking')}</h2>

    <div class="row gap-md">
      <label class="row gap-sm" style="cursor: pointer">
        <input type="checkbox" checked={store.duckingEnabled} onchange={handleDuckToggle} />
        {i18n.t('mixer.autoDuckMusic')} <kbd>Ctrl+D</kbd>
      </label>
    </div>

    <div class="row gap-md" style="margin-top: 8px">
      <label for="duck-amount" style="min-width: 52px">{i18n.t('mixer.amount')}</label>
      <input
        id="duck-amount"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={store.duckAmount}
        oninput={handleDuckAmount}
        disabled={!store.duckingEnabled}
        aria-label={i18n.t('mixer.amountAria')}
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.duckAmount * 100)}%</span>
    </div>

    <p class="text-sm text-muted" style="margin-top: 4px">
      {@html i18n.t('mixer.manualDuckHint', { key: '<kbd>Ctrl+Shift+D</kbd>' })}
    </p>
  </div>
</section>
