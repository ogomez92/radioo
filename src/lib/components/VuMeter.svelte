<script lang="ts">
  let { level = 0 }: { level: number; label?: string } = $props();

  const pct = $derived(Math.min(100, Math.max(0, level * 100)));
  const db = $derived(level > 0.0001 ? (20 * Math.log10(level)).toFixed(1) : '-inf');
</script>

<div class="vu-meter" aria-hidden="true">
  <div class="meter-track">
    <div class="meter-fill" style="width: {pct}%"></div>
  </div>
  <span class="vu-db text-sm text-muted">{db} dB</span>
</div>

<style>
  .vu-meter {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .meter-track {
    flex: 1;
    height: 8px;
    background: var(--bg-input);
    border-radius: 4px;
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 60ms linear;
    background: linear-gradient(90deg, var(--success) 0%, var(--success) 60%, var(--warning) 80%, var(--danger) 100%);
  }

  .vu-db {
    min-width: 56px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
