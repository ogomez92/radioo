<script lang="ts">
  import { store } from '../stores/app-store.svelte';

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
  <h2 id="music-heading">Music Player</h2>

  <div class="row gap-md" style="flex-wrap: wrap">
    <button
      class="btn-outline"
      onclick={onLoadFile}
      aria-label="Open audio file (Ctrl+O)"
      title="Open audio file (Ctrl+O)"
    >
      Open File… <kbd>Ctrl+O</kbd>
    </button>

    <button
      class="btn-outline"
      onclick={onTogglePlay}
      disabled={!store.musicFileName}
      aria-label={store.musicPlaying ? 'Pause music (Ctrl+P)' : 'Play music (Ctrl+P)'}
      title="Play/Pause (Ctrl+P)"
    >
      {store.musicPlaying ? '⏸ Pause' : '▶ Play'} <kbd>Ctrl+P</kbd>
    </button>

    <button
      class="btn-outline"
      onclick={onAnnounceProgress}
      disabled={!store.musicFileName}
      aria-label="Announce music progress (Ctrl+Shift+R)"
      title="Announce music progress (Ctrl+Shift+R)"
    >
      Time <kbd>Ctrl+Shift+R</kbd>
    </button>

    {#if store.musicFileName}
      <span class="text-sm text-muted" style="align-self: center">
        {store.musicFileName}
      </span>
    {/if}
  </div>

  <div class="row gap-md" style="margin-top: 10px">
    <label for="music-volume" style="min-width: 52px">Volume</label>
    <input
      id="music-volume"
      type="range"
      min="0"
      max="100"
      step="1"
      value={store.musicVolume}
      oninput={handleVolume}
      aria-label="Music volume"
    />
    <span class="text-sm text-muted" style="min-width: 36px">{store.musicVolume}%</span>
  </div>

  <p class="text-sm text-muted" style="margin-top: 4px">
    <kbd>Ctrl+I</kbd> / <kbd>Ctrl+K</kbd> adjust music volume ±5 (global)
  </p>
</section>
