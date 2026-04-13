<script lang="ts">
  import { store } from '../stores/app-store.svelte';

  const statusText = $derived.by(() => {
    if (store.reconnecting) return 'Reconnecting...';
    if (store.connected) return `Connected to ${new URL(store.streamUrl).host}`;
    if (store.streaming) return 'Starting...';
    return 'Idle';
  });

  const formatLabel = $derived(store.streamFormat.toUpperCase() + ' ' + store.streamBitrate + 'kbps');
</script>

<footer class="app-footer" aria-label="Application status">
  <span class="row gap-sm">
    {#if store.streaming}
      <span class="status-dot live" aria-label="Live"></span>
    {:else if store.connected}
      <span class="status-dot connected" aria-label="Connected"></span>
    {:else}
      <span class="status-dot" aria-label="Disconnected"></span>
    {/if}
    <span>{statusText}</span>
  </span>

  {#if store.streaming || store.recording}
    <span aria-label="Output format">{formatLabel}</span>
    <span aria-label="Duration">{store.durationFormatted}</span>
  {/if}

  {#if store.recording}
    <span class="row gap-sm">
      <span class="status-dot live" aria-hidden="true"></span>
      REC
    </span>
  {/if}

  {#if store.hlsActive}
    <span>HLS</span>
  {/if}

  {#if store.error}
    <span class="text-danger" role="alert">{store.error}</span>
  {/if}

  <span class="shortcuts text-muted" style="margin-left: auto;">
    <kbd>Ctrl+M</kbd> Mic Mute
    <kbd>Ctrl+Shift+M</kbd> Sys Mute
    <kbd>Ctrl+D</kbd> Duck
    <kbd>Ctrl+S</kbd> Stream
    <kbd>Ctrl+R</kbd> Record
  </span>
</footer>

<style>
  .shortcuts {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: wrap;
  }

  .shortcuts kbd {
    margin-right: 2px;
  }
</style>
