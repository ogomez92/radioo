<script lang="ts">
  interface Option { value: string; label: string; }

  let {
    options,
    value,
    onChange,
    label,
  }: {
    options: Option[];
    value: string;
    onChange: (v: string) => void;
    label: string;
  } = $props();

  let open = $state(false);
  let activeIndex = $state(0);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let listboxEl: HTMLUListElement | undefined = $state();
  const listboxId = `cb-${Math.random().toString(36).slice(2, 10)}`;

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '');

  function openList(): void {
    open = true;
    const idx = options.findIndex((o) => o.value === value);
    activeIndex = idx >= 0 ? idx : 0;
  }

  function closeList(): void {
    open = false;
  }

  function selectIndex(i: number): void {
    if (i < 0 || i >= options.length) return;
    onChange(options[i].value);
    closeList();
    buttonEl?.focus();
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openList(); return; }
      activeIndex = Math.min(options.length - 1, activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      activeIndex = Math.max(0, activeIndex - 1);
    } else if (e.key === 'Home') {
      if (open) { e.preventDefault(); activeIndex = 0; }
    } else if (e.key === 'End') {
      if (open) { e.preventDefault(); activeIndex = options.length - 1; }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) selectIndex(activeIndex);
      else openList();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (open) selectIndex(activeIndex);
      else openList();
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); closeList(); }
    } else if (e.key === 'Tab') {
      if (open) closeList();
    }
  }

  function onDocMouseDown(e: MouseEvent): void {
    if (!open) return;
    const target = e.target as Node;
    if (buttonEl?.contains(target) || listboxEl?.contains(target)) return;
    closeList();
  }

  $effect(() => {
    if (open) {
      document.addEventListener('mousedown', onDocMouseDown);
      return () => document.removeEventListener('mousedown', onDocMouseDown);
    }
  });
</script>

<div class="combobox">
  <button
    bind:this={buttonEl}
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open ? `${listboxId}-opt-${activeIndex}` : undefined}
    aria-label={label}
    class="cb-button"
    onclick={() => (open ? closeList() : openList())}
    onkeydown={handleKey}
  >
    <span class="cb-label">{selectedLabel}</span>
    <span class="cb-arrow" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <ul
      bind:this={listboxEl}
      role="listbox"
      id={listboxId}
      tabindex="-1"
      class="cb-listbox"
      aria-label={label}
    >
      {#each options as opt, i (opt.value)}
        <li
          id="{listboxId}-opt-{i}"
          role="option"
          aria-selected={opt.value === value}
          class="cb-option"
          class:active={i === activeIndex}
          onmousedown={(e) => { e.preventDefault(); selectIndex(i); }}
          onmouseenter={() => (activeIndex = i)}
        >
          {opt.label}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combobox {
    position: relative;
    display: inline-block;
  }

  .cb-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--bg-input);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font: inherit;
    min-width: 120px;
    justify-content: space-between;
  }

  .cb-button:hover {
    border-color: var(--border-focus);
  }

  .cb-button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  .cb-arrow {
    font-size: 10px;
    opacity: 0.7;
  }

  .cb-listbox {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 100%;
    list-style: none;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    padding: 4px 0;
    margin: 0;
    z-index: 1000;
    max-height: 300px;
    overflow-y: auto;
  }

  .cb-option {
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  .cb-option.active {
    background: var(--accent);
    color: white;
  }

  .cb-option[aria-selected='true']::before {
    content: '✓ ';
    opacity: 0.8;
  }
</style>
