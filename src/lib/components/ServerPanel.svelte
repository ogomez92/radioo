<script lang="ts">
  import { store } from '../stores/app-store.svelte';
  import { FORMAT_LABELS, BITRATE_OPTIONS, type StreamFormat } from '../types';
  import { tick } from 'svelte';

  let { onSave }: { onSave: () => void } = $props();
  const formats = Object.entries(FORMAT_LABELS) as [StreamFormat, string][];
  let nameInput: HTMLInputElement | undefined = $state();
  let editingName = $state('');
  let showNameInput = $state(false);

  function handleProfileSelect(e: Event) {
    const id = (e.target as HTMLSelectElement).value;
    if (id) {
      store.loadProfile(id);
      onSave();
    } else {
      store.activeProfileId = '';
    }
  }

  async function startSave() {
    const active = store.serverProfiles.find((p) => p.id === store.activeProfileId);
    if (active) {
      store.saveProfile(active.name);
      onSave();
    } else {
      editingName = store.streamName || 'My Server';
      showNameInput = true;
      await tick();
      nameInput?.focus();
      nameInput?.select();
    }
  }

  function confirmSave() {
    if (!editingName.trim()) return;
    store.saveProfile(editingName.trim());
    showNameInput = false;
    onSave();
  }

  function cancelSave() {
    showNameInput = false;
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') confirmSave();
    else if (e.key === 'Escape') cancelSave();
  }

  function deleteActive() {
    if (!store.activeProfileId) return;
    store.deleteProfile(store.activeProfileId);
    onSave();
  }

  const activeProfile = $derived(
    store.serverProfiles.find((p) => p.id === store.activeProfileId)
  );

  const isDirty = $derived(
    activeProfile != null && (
      activeProfile.url !== store.streamUrl ||
      activeProfile.username !== store.streamUsername ||
      activeProfile.password !== store.streamPassword ||
      activeProfile.streamName !== store.streamName
    )
  );
</script>

<section class="panel" aria-labelledby="profiles-heading">
  <h2 id="profiles-heading">Server Profiles</h2>

  <div class="row gap-md profile-row">
    <select
      value={store.activeProfileId}
      onchange={handleProfileSelect}
      aria-label="Select server profile"
      class="flex-1"
    >
      <option value="">-- New Server --</option>
      {#each store.serverProfiles as profile}
        <option value={profile.id}>{profile.name}</option>
      {/each}
    </select>

    {#if showNameInput}
      <input
        type="text"
        bind:this={nameInput}
        bind:value={editingName}
        onkeydown={handleNameKeydown}
        placeholder="Profile name"
        aria-label="Profile name"
        style="max-width: 160px"
      />
      <button class="btn-primary btn-sm" onclick={confirmSave}>Save</button>
      <button class="btn-outline btn-sm" onclick={cancelSave}>Cancel</button>
    {:else}
      <button
        class="btn-outline btn-sm"
        onclick={startSave}
        disabled={!store.streamUrl}
        aria-label={activeProfile ? 'Update current profile' : 'Save as new profile'}
      >
        {activeProfile ? (isDirty ? 'Update' : 'Saved') : 'Save'}
      </button>
      {#if activeProfile}
        <button
          class="btn-outline btn-sm text-danger"
          onclick={deleteActive}
          aria-label="Delete profile {activeProfile.name}"
        >
          Delete
        </button>
      {/if}
    {/if}
  </div>
</section>

<section class="panel" aria-labelledby="server-heading">
  <h2 id="server-heading">Icecast Server</h2>

  <div class="col gap-sm">
    <div class="col gap-sm">
      <label for="stream-url">Server URL</label>
      <input
        id="stream-url"
        type="url"
        placeholder="https://radio.example.com:8000/live"
        bind:value={store.streamUrl}
        aria-describedby="url-hint"
      />
      <span id="url-hint" class="text-sm text-muted">http(s)://host:port/mount</span>
    </div>

    <div class="two-col">
      <div class="col gap-sm">
        <label for="stream-user">Username</label>
        <input id="stream-user" type="text" bind:value={store.streamUsername} />
      </div>
      <div class="col gap-sm">
        <label for="stream-pass">Password</label>
        <input id="stream-pass" type="password" bind:value={store.streamPassword} autocomplete="off" />
      </div>
    </div>

    <div class="col gap-sm">
      <label for="stream-name">Stream Name</label>
      <input id="stream-name" type="text" bind:value={store.streamName} />
    </div>

    <div class="two-col">
      <div class="col gap-sm">
        <label for="srv-format">Format</label>
        <select id="srv-format" bind:value={store.streamFormat}>
          {#each formats as [value, label]}
            <option {value}>{label}</option>
          {/each}
        </select>
      </div>
      <div class="col gap-sm">
        <label for="srv-bitrate">Bitrate (kbps)</label>
        <select id="srv-bitrate" bind:value={store.streamBitrate}>
          {#each BITRATE_OPTIONS as br}
            <option value={br}>{br}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>
</section>

<section class="panel" aria-labelledby="hls-heading">
  <h2 id="hls-heading">HLS Output</h2>

  <div class="col gap-sm">
    <label class="row gap-sm" style="cursor: pointer">
      <input type="checkbox" bind:checked={store.hlsEnabled} />
      Enable HLS output
    </label>

    {#if store.hlsEnabled}
      <div class="col gap-sm">
        <label for="hls-path">Output path</label>
        <input
          id="hls-path"
          type="text"
          placeholder="/path/to/hls/output/stream.m3u8"
          bind:value={store.hlsPath}
        />
      </div>
    {/if}
  </div>
</section>

<style>
  .profile-row {
    flex-wrap: wrap;
  }

  .btn-sm {
    padding: 4px 10px;
    font-size: 12px;
  }
</style>
