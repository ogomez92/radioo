<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { FORMAT_LABELS, BITRATE_OPTIONS, type StreamFormat } from '../types';

  const formats = Object.entries(FORMAT_LABELS) as [StreamFormat, string][];
</script>

<section class="panel" aria-labelledby="encoding-heading">
  <h2 id="encoding-heading">Encoding</h2>

  <div class="two-col">
    <div class="col gap-sm">
      <label for="stream-format">Format</label>
      <select id="stream-format" bind:value={store.streamFormat}>
        {#each formats as [value, label]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </div>
    <div class="col gap-sm">
      <label for="stream-bitrate">Bitrate (kbps)</label>
      <select id="stream-bitrate" bind:value={store.streamBitrate}>
        {#each BITRATE_OPTIONS as br}
          <option value={br}>{br}</option>
        {/each}
      </select>
    </div>
  </div>

  <p class="text-sm text-muted" style="margin-top: 8px">
    Used for both streaming and local recording.
  </p>
</section>
