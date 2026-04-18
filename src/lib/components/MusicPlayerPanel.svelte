<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';

  let {
    onLoadFile,
    onTogglePlay,
    onVolumeChange,
    onAnnounceProgress,
  }: {
    onLoadFile: () => void;
    onTogglePlay: () => void;
    onVolumeChange: (v: number) => void;
    onAnnounceProgress: () => void;
  } = $props();

  function handleVolume(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    store.musicVolume = v;
    onVolumeChange(v);
  }
</script>

<section class="panel" aria-labelledby="music-heading">
  <h2 id="music-heading">{i18n.t('music.heading')}</h2>

  <div class="row gap-md" style="flex-wrap: wrap">
    <button
      class="btn-outline"
      onclick={onLoadFile}
      aria-label={i18n.t('music.openFileAria', { key: 'Ctrl+O' })}
      title={i18n.t('music.openFileAria', { key: 'Ctrl+O' })}
    >
      {i18n.t('music.openFile')} <kbd>Ctrl+O</kbd>
    </button>

    <button
      class="btn-outline"
      onclick={onTogglePlay}
      disabled={!store.musicFileName}
      aria-label={store.musicPlaying ? i18n.t('music.pauseAria', { key: 'Ctrl+P' }) : i18n.t('music.playAria', { key: 'Ctrl+P' })}
      title={store.musicPlaying ? i18n.t('music.pauseAria', { key: 'Ctrl+P' }) : i18n.t('music.playAria', { key: 'Ctrl+P' })}
    >
      {store.musicPlaying ? `⏸ ${i18n.t('music.pause')}` : `▶ ${i18n.t('music.play')}`} <kbd>Ctrl+P</kbd>
    </button>

    <button
      class="btn-outline"
      onclick={onAnnounceProgress}
      disabled={!store.musicFileName}
      aria-label={i18n.t('music.timeAria', { key: 'Ctrl+Shift+R' })}
      title={i18n.t('music.timeAria', { key: 'Ctrl+Shift+R' })}
    >
      {i18n.t('music.time')} <kbd>Ctrl+Shift+R</kbd>
    </button>

    {#if store.musicFileName}
      <span class="text-sm text-muted" style="align-self: center">
        {store.musicFileName}
      </span>
    {/if}
  </div>

  <div class="row gap-md" style="margin-top: 10px">
    <label for="music-volume" style="min-width: 52px">{i18n.t('music.volume')}</label>
    <input
      id="music-volume"
      type="range"
      min="0"
      max="100"
      step="1"
      value={store.musicVolume}
      oninput={handleVolume}
      aria-label={i18n.t('music.volumeAria')}
    />
    <span class="text-sm text-muted" style="min-width: 36px">{store.musicVolume}%</span>
  </div>

  <p class="text-sm text-muted" style="margin-top: 4px">
    {@html i18n.t('music.volumeHint', { down: '<kbd>Ctrl+I</kbd>', up: '<kbd>Ctrl+K</kbd>' })}
  </p>
</section>
