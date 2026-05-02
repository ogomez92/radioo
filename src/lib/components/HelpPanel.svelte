<script lang="ts">
  import { i18n } from '../i18n/i18n.svelte';

  // Shortcut rows. `keys` is rendered literally — the key combos are not
  // localized, but the descriptions are. `global: true` marks entries that
  // fire even when Radioo isn't focused (registered in electron/main.ts).
  const shortcuts: Array<{ keys: string; labelKey: string; global?: boolean }> = [
    { keys: 'Ctrl+M', labelKey: 'help.shortcuts.micMute' },
    { keys: 'Ctrl+Shift+M', labelKey: 'help.shortcuts.sysMute', global: true },
    { keys: 'Ctrl+D', labelKey: 'help.shortcuts.duck' },
    { keys: 'Ctrl+Shift+D', labelKey: 'help.shortcuts.duckHold', global: true },
    { keys: 'Ctrl+S', labelKey: 'help.shortcuts.stream' },
    { keys: 'Ctrl+R', labelKey: 'help.shortcuts.record' },
    { keys: 'Ctrl+O', labelKey: 'help.shortcuts.openMusic' },
    { keys: 'Ctrl+P', labelKey: 'help.shortcuts.playMusic' },
    { keys: 'Ctrl+I', labelKey: 'help.shortcuts.volUp', global: true },
    { keys: 'Ctrl+K', labelKey: 'help.shortcuts.volDown', global: true },
    { keys: 'Ctrl+Shift+R', labelKey: 'help.shortcuts.musicProgress' },
    { keys: 'Ctrl+Shift+C', labelKey: 'help.shortcuts.micStatus' },
    { keys: 'Ctrl+L', labelKey: 'help.shortcuts.listeners' },
    { keys: 'Ctrl+Shift+S', labelKey: 'help.shortcuts.toggleScreenReader', global: true },
  ];
</script>

<section class="panel" aria-labelledby="help-heading">
  <h2 id="help-heading">{i18n.t('help.heading')}</h2>

  <h3>{i18n.t('help.gettingStartedHeading')}</h3>
  <p>{i18n.t('help.gettingStartedBody')}</p>

  <h3>{i18n.t('help.sourcesHeading')}</h3>
  <p>{i18n.t('help.sourcesBody')}</p>

  <h3>{i18n.t('help.pickerKeysHeading')}</h3>
  <p>{i18n.t('help.pickerKeysBody')}</p>

  <h3>{i18n.t('help.shortcutsHeading')}</h3>
  <p class="text-sm text-muted">{i18n.t('help.globalLegend')}</p>

  <table class="shortcut-table">
    <thead>
      <tr>
        <th scope="col">{i18n.t('help.colShortcut')}</th>
        <th scope="col">{i18n.t('help.colAction')}</th>
      </tr>
    </thead>
    <tbody>
      {#each shortcuts as s (s.keys)}
        <tr>
          <td><kbd>{s.keys}</kbd>{#if s.global} <span aria-hidden="true">★</span>{/if}</td>
          <td>{i18n.t(s.labelKey)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  h3 {
    margin-top: 18px;
    margin-bottom: 6px;
  }
  p {
    margin: 0 0 6px 0;
    line-height: 1.5;
  }
  .shortcut-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
  }
  .shortcut-table th,
  .shortcut-table td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border, #2a2a3a);
  }
  .shortcut-table th {
    font-weight: 600;
    color: var(--text-secondary, #aaa);
  }
  .shortcut-table td:first-child {
    white-space: nowrap;
    min-width: 160px;
  }
</style>
