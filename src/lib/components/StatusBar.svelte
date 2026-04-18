<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';

  const statusText = $derived.by(() => {
    if (store.reconnecting) return i18n.t('status.reconnecting');
    if (store.connected) {
      try {
        return i18n.t('status.connectedTo', { host: new URL(store.streamUrl).host });
      } catch {
        return i18n.t('status.connectedTo', { host: store.streamUrl });
      }
    }
    if (store.streaming) return i18n.t('status.starting');
    return i18n.t('status.idle');
  });

  const formatLabel = $derived(store.streamFormat.toUpperCase() + ' ' + store.streamBitrate + 'kbps');
</script>

<footer class="app-footer" aria-label={i18n.t('status.appAria')}>
  <span class="row gap-sm">
    {#if store.streaming}
      <span class="status-dot live" aria-label={i18n.t('status.live')}></span>
    {:else if store.connected}
      <span class="status-dot connected" aria-label={i18n.t('status.connected')}></span>
    {:else}
      <span class="status-dot" aria-label={i18n.t('status.disconnected')}></span>
    {/if}
    <span>{statusText}</span>
  </span>

  {#if store.streaming || store.recording}
    <span aria-label={i18n.t('status.outputFormatAria')}>{formatLabel}</span>
    <span aria-label={i18n.t('status.durationAria')}>{store.durationFormatted}</span>
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
    <kbd>Ctrl+M</kbd> {i18n.t('shortcuts.micMute')}
    <kbd>Ctrl+Shift+M</kbd> {i18n.t('shortcuts.sysMute')}
    <kbd>Ctrl+D</kbd> {i18n.t('shortcuts.duck')}
    <kbd>Ctrl+S</kbd> {i18n.t('shortcuts.stream')}
    <kbd>Ctrl+R</kbd> {i18n.t('shortcuts.record')}
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
