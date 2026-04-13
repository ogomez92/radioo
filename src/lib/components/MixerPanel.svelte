<script lang="ts">
  import { store } from '../stores/app-store.svelte';
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
  <h2 id="mixer-heading">Mixer</h2>

  <div class="col gap-sm">
    <div class="row gap-md">
      <label for="master-gain" style="min-width: 52px">Master</label>
      <input
        id="master-gain"
        type="range"
        min="0"
        max="2"
        step="0.01"
        value={store.masterGain}
        oninput={handleMaster}
        aria-label="Master output gain"
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.masterGain * 100)}%</span>
    </div>

    <VuMeter level={store.masterLevelL} label="Master output level" />
  </div>

  <div class="ducking-section" style="margin-top: 16px">
    <h2 id="ducking-heading">Ducking</h2>

    <div class="row gap-md">
      <label class="row gap-sm" style="cursor: pointer">
        <input type="checkbox" checked={store.duckingEnabled} onchange={handleDuckToggle} />
        Auto-duck music <kbd>Ctrl+D</kbd>
      </label>
    </div>

    <div class="row gap-md" style="margin-top: 8px">
      <label for="duck-amount" style="min-width: 52px">Amount</label>
      <input
        id="duck-amount"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={store.duckAmount}
        oninput={handleDuckAmount}
        disabled={!store.duckingEnabled}
        aria-label="Duck amount — how much to reduce music when speaking"
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.duckAmount * 100)}%</span>
    </div>

    <p class="text-sm text-muted" style="margin-top: 4px">
      Hold <kbd>Ctrl+Shift+D</kbd> to manually duck music
    </p>
  </div>
</section>
