<script lang="ts">
  import { tick } from 'svelte';
  import { store } from '../stores/app-store.svelte';
  import { i18n } from '../i18n/i18n.svelte';
  import VuMeter from './VuMeter.svelte';

  let {
    onMicChange,
    onMicGainChange,
    onSysGainChange,
  }: {
    onMicChange: (id: string) => void;
    onMicGainChange: (v: number) => void;
    onSysGainChange: (v: number) => void;
  } = $props();

  async function refreshDevices() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied - proceed with what we can enumerate
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.availableDevices = devices.filter((d) => d.kind === 'audioinput');
  }

  $effect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  });

  function handleMicSelect(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    store.micDeviceId = value;
    onMicChange(value);
  }

  function handleMicGain(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.micGain = v;
    onMicGainChange(v);
  }

  function handleSysGain(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    store.sysGain = v;
    onSysGainChange(v);
  }

  // --- Per-process capture UI ---

  type Session = { pid: number; process_name: string; display_name: string; state: number };
  let sessions = $state<Session[]>([]);
  let pickerOpen = $state(false);
  let loadingSessions = $state(false);
  let listboxEl = $state<HTMLDivElement | undefined>();
  let previousFocus: HTMLElement | null = null;
  // Roving-focus index into `sessions`. Drives aria-activedescendant on the
  // listbox container and controls which option gets visual focus styling.
  let activeIndex = $state(0);
  // Local multi-select set. Mirrors store.syscapPids while the picker is open;
  // on close we diff back into the store so names stay in sync.
  let selected = $state<Set<number>>(new Set());

  async function loadSessions() {
    loadingSessions = true;
    try {
      const res = await window.api?.syscapList();
      if (res) sessions = res;
    } finally {
      loadingSessions = false;
    }
    // Clamp activeIndex if the list shrank; focus the container so arrow-key
    // nav works without the user needing to click into it first.
    if (activeIndex >= sessions.length) activeIndex = Math.max(0, sessions.length - 1);
    await tick();
    listboxEl?.focus();
  }

  async function openPicker() {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Seed local selection from the current persisted list so the picker acts
    // as an in-place manager (Space toggles membership) rather than append-only.
    selected = new Set(store.syscapPids);
    activeIndex = 0;
    pickerOpen = true;
    await loadSessions();
  }

  function closePicker() {
    // Commit multi-select into the store. Preserve friendly names for pids
    // still selected; drop names for pids the user deselected.
    const pids = [...selected];
    const names: Record<number, string> = {};
    for (const pid of pids) {
      const s = sessions.find((x) => x.pid === pid);
      const existing = store.syscapPidNames[pid];
      const name = s?.process_name || existing || `pid ${pid}`;
      names[pid] = name;
    }
    store.syscapPids = pids;
    store.syscapPidNames = names;
    pickerOpen = false;
    previousFocus?.focus();
    previousFocus = null;
  }

  function toggleAt(index: number) {
    const s = sessions[index];
    if (!s) return;
    const next = new Set(selected);
    if (next.has(s.pid)) next.delete(s.pid);
    else next.add(s.pid);
    selected = next;
  }

  function removePid(pid: number) {
    store.syscapPids = store.syscapPids.filter((p) => p !== pid);
    const { [pid]: _, ...rest } = store.syscapPidNames;
    store.syscapPidNames = rest;
  }

  function handleListboxKey(e: KeyboardEvent) {
    if (sessions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        activeIndex = Math.min(sessions.length - 1, activeIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        activeIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        activeIndex = sessions.length - 1;
        break;
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        toggleAt(activeIndex);
        break;
      case 'Enter':
        e.preventDefault();
        closePicker();
        break;
    }
  }

  $effect(() => {
    // Keep the active option scrolled into view after arrow-key nav.
    if (!pickerOpen || !listboxEl) return;
    const el = listboxEl.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  });

  function pidLabel(pid: number): string {
    return store.syscapPidNames[pid] ?? `pid ${pid}`;
  }

  function setMode(mode: 'all' | 'include' | 'exclude') {
    store.syscapMode = mode;
  }

  // Primary radio: "all" vs "filtered". When the user switches TO filtered,
  // we default to exclude mode (the more common use case — silence a specific
  // app while still broadcasting the rest of the system).
  function setPrimaryMode(primary: 'all' | 'filtered') {
    if (primary === 'all') {
      store.syscapMode = 'all';
    } else if (store.syscapMode === 'all') {
      store.syscapMode = 'exclude';
    }
  }

  function toggleSyscap() {
    store.syscapEnabled = !store.syscapEnabled;
  }
</script>

<section class="panel" aria-labelledby="sources-heading">
  <h2 id="sources-heading">{i18n.t('sources.heading')}</h2>

  <!-- Microphone -->
  <div class="source-block">
    <div class="col gap-sm">
      <label for="mic-select">{i18n.t('sources.microphone')}</label>
      <select id="mic-select" value={store.micDeviceId} onchange={handleMicSelect}>
        <option value="">{i18n.t('sources.none')}</option>
        {#each store.availableDevices as device}
          <option value={device.deviceId}>
            {device.label || `Mic ${device.deviceId.slice(0, 8)}`}
          </option>
        {/each}
      </select>
    </div>

    <div class="row gap-md" style="margin-top: 8px">
      <label for="mic-gain" class="sr-only">{i18n.t('sources.micGain')}</label>
      <input
        id="mic-gain"
        type="range"
        min="0"
        max="2"
        step="0.01"
        value={store.micGain}
        oninput={handleMicGain}
        aria-label={i18n.t('sources.micGain')}
      />
      <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.micGain * 100)}%</span>
    </div>

    <VuMeter level={store.micLevel} label={i18n.t('sources.micLevel')} />
  </div>

  <!-- Per-process system audio capture -->
  <div class="source-block" style="margin-top: 16px">
    <div class="row gap-md">
      <label class="row gap-sm" style="cursor: pointer">
        <input
          type="checkbox"
          checked={store.syscapEnabled}
          onchange={toggleSyscap}
          disabled={!store.syscapSupported}
        />
        {i18n.t('sources.systemAudio')}
      </label>
    </div>

    {#if !store.syscapSupported}
      <p class="text-sm text-muted" style="margin-top: 6px">
        {i18n.t('sources.syscapUnsupported')}
      </p>
    {:else if store.syscapEnabled}
      <fieldset class="syscap-mode" style="margin-top: 10px">
        <legend class="sr-only">{i18n.t('sources.syscapHeading')}</legend>
        <label class="row gap-sm">
          <input
            type="radio"
            name="syscap-primary"
            value="all"
            checked={store.syscapMode === 'all'}
            onchange={() => setPrimaryMode('all')}
          />
          {i18n.t('sources.syscapModeAll')}
        </label>
        <label class="row gap-sm" style="margin-top: 4px">
          <input
            type="radio"
            name="syscap-primary"
            value="filtered"
            checked={store.syscapMode !== 'all'}
            onchange={() => setPrimaryMode('filtered')}
          />
          {i18n.t('sources.syscapModeFiltered')}
        </label>

        {#if store.syscapMode !== 'all'}
          <fieldset class="syscap-mode-nested" style="margin-top: 6px; margin-left: 24px">
            <legend class="sr-only">{i18n.t('sources.syscapHeading')}</legend>
            <label class="row gap-sm">
              <input
                type="radio"
                name="syscap-filter"
                value="include"
                checked={store.syscapMode === 'include'}
                onchange={() => setMode('include')}
              />
              {i18n.t('sources.syscapModeInclude')}
            </label>
            <label class="row gap-sm" style="margin-top: 4px">
              <input
                type="radio"
                name="syscap-filter"
                value="exclude"
                checked={store.syscapMode === 'exclude'}
                onchange={() => setMode('exclude')}
              />
              {i18n.t('sources.syscapModeExclude')}
            </label>

            <div class="chip-row" aria-label={i18n.t('sources.syscapHeading')}>
              {#each store.syscapPids as pid (pid)}
                <span class="chip">
                  <span>{pidLabel(pid)}</span>
                  <button
                    type="button"
                    class="chip-remove"
                    aria-label={`Remove ${pidLabel(pid)}`}
                    onclick={() => removePid(pid)}
                  >×</button>
                </span>
              {:else}
                <span class="text-sm text-muted">{i18n.t('sources.syscapNoSelection')}</span>
              {/each}
            </div>

            {#if store.syscapMode === 'exclude' && store.syscapPids.length > 1}
              <p class="text-sm text-muted warning-line" style="margin-top: 4px">
                {i18n.t('sources.syscapExcludeOneOnly')}
              </p>
            {/if}

            <div class="row gap-sm" style="margin-top: 8px">
              <button type="button" class="btn-outline btn-sm" onclick={openPicker}>
                {i18n.t('sources.syscapAdd')}
              </button>
            </div>
          </fieldset>
        {/if}
      </fieldset>

      <p class="text-sm text-muted" style="margin-top: 6px">
        {@html i18n.t('sources.syscapScreenReaderHint', { key: '<kbd>Ctrl+Shift+S</kbd>' })}
      </p>

      <div class="row gap-md" style="margin-top: 8px">
        <label for="sys-gain" class="sr-only">{i18n.t('sources.sysGain')}</label>
        <input
          id="sys-gain"
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={store.sysGain}
          oninput={handleSysGain}
          aria-label={i18n.t('sources.sysGain')}
        />
        <span class="text-sm text-muted" style="min-width: 36px">{Math.round(store.sysGain * 100)}%</span>
      </div>
    {/if}
  </div>
</section>

{#if pickerOpen}
  <!-- svelte-ignore a11y_interactive_supports_focus a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div
    class="picker-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="syscap-picker-title"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) closePicker(); }}
    onkeydown={(e) => { if (e.key === 'Escape') closePicker(); }}
  >
    <div class="picker-panel">
      <div class="row gap-md picker-header">
        <h3 id="syscap-picker-title" style="margin: 0">{i18n.t('sources.syscapAddTitle')}</h3>
        <button type="button" class="btn-sm" onclick={loadSessions}>{i18n.t('sources.syscapRefresh')}</button>
        <button type="button" class="btn-sm" onclick={closePicker}>{i18n.t('sources.syscapClose')}</button>
      </div>

      {#if loadingSessions}
        <p class="text-muted">…</p>
      {:else}
        <div
          class="session-list"
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby="syscap-picker-title"
          aria-activedescendant={sessions[activeIndex] ? `syscap-option-${sessions[activeIndex].pid}` : undefined}
          tabindex="0"
          bind:this={listboxEl}
          onkeydown={handleListboxKey}
        >
          {#each sessions as s, i (`${s.pid}-${i}`)}
            {@const isSelected = selected.has(s.pid)}
            {@const isActive = i === activeIndex}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="syscap-option-{s.pid}"
              class="session-row"
              class:active={isActive}
              class:selected={isSelected}
              role="option"
              aria-selected={isSelected}
              data-idx={i}
              onclick={() => { activeIndex = i; toggleAt(i); }}
            >
              <span class="session-check" aria-hidden="true">{isSelected ? '☑' : '☐'}</span>
              <span class="session-name">{s.process_name || `pid ${s.pid}`}</span>
              <span class="text-sm text-muted">
                {s.state === 1 ? i18n.t('sources.syscapStateActive') : i18n.t('sources.syscapStateIdle')}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .source-block {
    padding-bottom: 8px;
  }
  .syscap-mode,
  .syscap-mode-nested {
    border: 0;
    padding: 0;
    margin: 0;
  }
  .syscap-mode-nested {
    border-left: 1px solid var(--border, #333);
    padding-left: 12px;
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    min-height: 24px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 8px;
    border-radius: 999px;
    background: var(--surface-elev, #1e1e2a);
    border: 1px solid var(--border, #333);
    font-size: 0.85rem;
  }
  .chip-remove {
    background: transparent;
    border: 0;
    color: var(--text-secondary, #aaa);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .chip-remove:hover {
    color: var(--text, #fff);
  }
  .btn-sm {
    padding: 4px 10px;
    font-size: 0.85rem;
  }
  .warning-line {
    color: #e0b84d;
  }
  .picker-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 40;
  }
  .picker-panel {
    background: var(--surface, #1b1b26);
    border: 1px solid var(--border, #333);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 320px;
    max-width: 480px;
    max-height: 72vh;
    overflow: auto;
    color: var(--text, #fff);
  }
  .picker-header {
    align-items: center;
    margin-bottom: 8px;
  }
  .session-list {
    padding: 2px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    outline: none;
  }
  .session-list:focus-visible {
    box-shadow: 0 0 0 2px var(--accent, #5aa0ff);
    border-radius: 4px;
  }
  .session-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    text-align: left;
    color: inherit;
    cursor: pointer;
    user-select: none;
  }
  .session-row:hover {
    background: var(--surface-elev, #252535);
    border-color: var(--border, #444);
  }
  .session-row.active {
    background: var(--surface-elev, #252535);
    border-color: var(--accent, #5aa0ff);
  }
  .session-row.selected {
    background: var(--surface-elev, #2a2a3a);
  }
  .session-check {
    font-size: 1rem;
    min-width: 1em;
  }
  .session-name {
    flex: 1 1 auto;
    font-weight: 500;
  }
</style>
